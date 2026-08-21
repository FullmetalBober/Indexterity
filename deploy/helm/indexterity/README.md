# Indexterity Helm chart

Deploys the two workloads — **api** (which runs the job pipeline itself) and
**web** (dashboard) — from two images, plus a pre-upgrade migration job.
`topology` folds the whole release into one container when two Deployments is
more than an install needs.

PostgreSQL is **not** bundled: point `secrets.databaseUrl` at a managed
instance or your own postgres release — at its **direct** endpoint, since
`LISTEN/NOTIFY` does not survive transaction pooling and the api refuses to boot
on a URL that loses it (see the values table). That is the control-plane store;
the MongoDB clusters Indexterity manages are added later from the dashboard.

## Install

```bash
# 1. Build and push the images (repo root is the build context).
docker build -f apps/api/Dockerfile -t your-registry/indexterity-api:0.1.0 .
docker build -f apps/web/Dockerfile -t your-registry/indexterity-web:0.1.0 .
docker push your-registry/indexterity-api:0.1.0
docker push your-registry/indexterity-web:0.1.0

# 2. Install.
helm install indexterity deploy/helm/indexterity \
  --namespace indexterity --create-namespace \
  --set api.image.repository=your-registry/indexterity-api \
  --set web.image.repository=your-registry/indexterity-web \
  --set secrets.databaseUrl='postgres://user:pass@host:5432/indexterity' \
  --set secrets.betterAuthSecret="$(openssl rand -base64 32)" \
  --set secrets.masterKey="$(openssl rand -base64 32)" \
  --set ingress.enabled=true \
  --set ingress.host=indexterity.alivlad.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=indexterity-tls \
  --set config.trustProxy=10.0.0.0/8

# 3. Verify.
helm test indexterity -n indexterity
```

The web image does **not** need rebuilding per environment: `API_URL` and
`WEB_ORIGIN` are read at runtime, and the browser bundle contains no api address
at all — it calls `/api` on whatever origin served the page. `API_URL` is the web
server's own server-side rendering, nothing else.

## Topology: how many things to deploy

`topology` decides only how the same code is packaged. Nothing about the app
changes, and nothing in front of the chart does either: the `-api` and `-web`
Services keep their names, their ports and their labels in every case, so the
ingress, the ServiceMonitors and every in-cluster caller are unaffected.

| `topology` | What is installed | Images pulled |
|---|---|---|
| `split` (default) | Two Deployments. api and web roll, scale and fail independently — an api rollout cannot take the landing page down with it. What the hosted install runs | api, web |
| `single-container` | One Deployment, **one container**, from the all-in-one image: both processes under a supervisor that is PID 1 | all-in-one |

```bash
# One container, everything in it, including the schedule's tick.
helm install indexterity … --set topology=single-container
```

What `single-container` costs:

- **One failure domain.** api and web scale together (`api.replicas` counts the
  pods; `web.replicas` is ignored), and a dashboard change rolls the api with it.
- **The web metrics listener moves to `metrics.port + 1`** — one network
  namespace cannot bind one port twice. Both Services still *publish* 9464, so
  scrapers and `port-forward` read the same number as before; only the
  containerPort moved. `metrics.webPort` overrides it.

Switching an existing release replaces Deployments rather than editing them —
the old ones go and one appears. That is a rollout, not a reinstall; the data is
in Postgres and untouched.

### The all-in-one image, without this chart

`ghcr.io/fullmetalbober/indexterity-all-in-one` is the whole product in one
container, which is what a host that has no pods wants — Fly, Render, Cloud Run,
Compose, a single VM:

```bash
docker run -p 3000:3000 \
  -e DATABASE_URL='postgres://…' \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e MASTER_KEY="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=https://indexterity.example.com \
  -e WEB_ORIGIN=https://indexterity.example.com \
  ghcr.io/fullmetalbober/indexterity-all-in-one:0.4.0
```

Port 3000 is the only one that has to be published: the dashboard answers `/api`
itself, so one origin serves the browser everything. Migrations are not automatic
outside the chart — run them first, from the same image:

```bash
docker run --rm -e DATABASE_URL='postgres://…' \
  ghcr.io/fullmetalbober/indexterity-all-in-one:0.4.0 node apps/api/dist/migrate.js
```

The supervisor (`deploy/all-in-one/supervisor.ts`) splits the two variables the
processes would otherwise fight over — `WEB_METRICS_PORT` (default
`METRICS_PORT + 1`) and `WEB_SENTRY_DSN` (default: the api's project) — forwards
`SIGTERM` to both, and **exits non-zero the moment either process does**, so the
host restarts the container instead of leaving a dashboard serving 502s from a
passthrough with nothing behind it. The pipeline runs inside the api
in every image (#232), so there is no scheduler flag to carry.

## Memory

**V8 sizes its heap from the container's limit, not the host's memory.** It grows
into that ceiling happily, collecting only as it approaches — so RSS follows the
limit rather than the workload. The same api image, doing the same nothing:

| limit | V8 heap ceiling | RSS idle |
|---|---|---|
| none (16 GB host) | 4192 MB | 228 MB |
| 512 MiB | 268 MB | 104 MB |

Which means **raising a limit raises usage**. "Give it headroom to be safe" is how
a 128 MB service becomes a 512 MB one. Raise a limit when something is actually
OOMKilled, not in anticipation.

**But that sizing stops helping below 512 MiB, which is where this chart now
sits.** Measured on node 26, V8's default ceiling scales down to a point and then
flattens:

| container limit | 1 GiB | 512Mi | 384Mi | 320Mi | 256Mi | 192Mi | 96Mi |
|---|---|---|---|---|---|---|---|
| default heap ceiling | 536 MB | 268 MB | 268 MB | 268 MB | 262 MB | 262 MB | 262 MB |

At any limit of 256 MiB or below, a process believes it may hold **more heap than
its cgroup allows** — so a heap-heavy pass is killed for memory where it should
have been collected. The chart therefore sets `NODE_OPTIONS` on each container to
65% of that container's own limit, leaving the rest for what is not heap. Verified
against the images: a 208 MB cap produces a 220 MB ceiling under a 320 MiB limit,
a 166 MB cap a 172 MB ceiling under 256 MiB. `NODE_OPTIONS` in `extraEnv`
overrides it, and nothing is set when the share would fall below 64 MB — a heap
that small collects instead of serving.

The defaults are measured under load — page renders, api calls and concurrent
sign-ups, against the published images:

| workload | request | limit | measured serving |
|---|---|---|---|
| api | 128Mi | 320Mi | 99 MB under a 192 MiB limit |
| web | 96Mi | 256Mi | 93 MB under a 128 MiB limit |
| all-in-one | 192Mi | 384Mi | 85 MB under a 192 MiB limit |

They are floors for a small fleet. The collectors hold per-collection statistics
while they work, so an api managing many clusters sits higher — watch
`container_memory_working_set_bytes` on your own install before tightening
further.

Two things do not show up in steady-state observation:

- **Password hashing is memory-hard by design.** scrypt allocates roughly 32 MB
  per hash *in flight*, so a handful of simultaneous sign-ins is tens of megabytes
  that an idle graph never hints at. `config.authRateLimitMax` bounds the rate but
  not the concurrency, so the limit has to absorb it — which is why the api's is
  the largest of the three. This is not a knob to turn down: the cost *is* the
  brute-force resistance.
- **`WORKER_CONCURRENCY` multiplies rather than shares.** Each concurrent job
  holds its own working set. It defaults to 1; raise it (via `api.extraEnv`) with
  the limit, not alone.
- **Sockets are memory too, and some of them are not ours.** The driver would open
  up to 100 per connected cluster by default, held in a per-cluster session —
  `config.mongoMaxPoolSize` caps it at 10 and returns the surplus after 60s idle.

`single-container` is the one container the chart does **not** cap from here,
because one cap would be handed to both processes. Its supervisor divides the
budget at runtime instead — 40% of the container's limit to the api, 22% to the
dashboard, the rest unallocated for two runtimes' code and native allocation and
for scrypt, which allocates outside the heap. Without that split both runtimes
read the same cgroup and each claim the full default ceiling: 536 MB of heap
promised inside a 512 MiB container, invisible until both are busy at once.
`NODE_OPTIONS` in the environment overrides it, and the container logs what it
chose:

```
supervisor: memory limit 384MB — heap ceilings: api 153MB, web 84MB
```

`split` needs no such split: each container has a pod to itself, reads its own
cgroup, and is capped from its own limit like any other workload.

## Back up MASTER_KEY

Every customer connection string is sealed with `MASTER_KEY` (envelope
encryption). **If it is lost, no connected cluster can be reached again** and
each one must be re-onboarded. Store it outside the cluster. To rotate, add
`MASTER_KEY_V2` via `secrets.existingSecret` and set
`secrets.masterKeyVersion=2`; rows sealed with v1 stay readable.

## What talks to what

```
                     ┌── /api ──► api ──► PostgreSQL
browser ──► ingress ─┤              ▲  └────► customer MongoDB clusters
                     └── /  ───► web ┘           (SSR reads via the api's
                                                  in-cluster Service)
```

**One host, two paths.** The browser calls the api itself — that is what makes
the session cookie first-party — so `/api` has to answer on the same host that
serves the dashboard. The ingress template does that, and the api answers
directly.

Without an ingress it still works: the web pods answer `/api` themselves and
forward it, so the browser still sees one origin. That costs one hop per call,
which the ingress rule removes. `indexterity_web_requests_total{kind="api"}` is
non-zero exactly when the passthrough is carrying calls — a useful check that
the rule is doing its job.

With the ingress rule in place the api is publicly reachable on that path. Its rate limiting, origin
checks and auth guard are the only line of defence now rather than the second one
behind an unroutable address; nothing about them changed, but their importance
did. `ingress.api.*` adds a *second* hostname for callers outside the browser and
stays off by default — the dashboard does not need it.

## Values worth knowing

| Value | Why it matters |
|---|---|
| `topology` | `split` (default) or `single-container` — see above. Packaging only; the Services, the ingress and the app are the same in both |
| `api.replicas` / `web.replicas` | **One each by default.** Raise for HA or throughput — both are stateless, and api replicas tick concurrently without double-dispatching (a pass is claimed against its occurrence in `worker_watermarks`). `rateLimitMax` is per api process and Postgres connections grow ~10 per api replica |
| `allInOne.*` | Image and resources for `topology: single-container`. `api.image` and `web.image` are never pulled in that topology, and neither is a second copy of node |
| `metrics.webPort` | The dashboard's metrics containerPort. Empty means `metrics.port`, or `metrics.port + 1` when it shares a network namespace with the api |
| `secrets.databaseUrl` | The control-plane Postgres, and it has to be the **direct** endpoint — not Neon's `-pooler` host, PgBouncer or Supavisor in transaction mode. `LISTEN/NOTIFY` does not survive transaction pooling: the `LISTEN` is accepted and the notification never arrives, so the dashboard's live updates silently never fire. The api runs a `NOTIFY` round trip at boot and refuses to start when it is lost, which makes this a CrashLoopBackOff naming the reason instead of a dashboard that looks fine and never updates. A pooler buys the release nothing anyway — it holds about 10 connections at these defaults |
| `secrets.existingSecret` | Bring your own Secret (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `MASTER_KEY`, optionally `SMTP_PASS`, `GITHUB_CLIENT_SECRET`) instead of putting values in Helm |
| `web.publicUrl` | The dashboard's public origin. Defaults to the ingress host; the api trusts it for auth and session cookies are bound to it |
| `migrations.enabled` | The pre-install/pre-upgrade Job runs `node dist/migrate.js` before new pods start. Disable only if you migrate out of band |
| `smtp.*` | Without a host, invites, alerts, verification and reset mails are logged and dropped |
| `config.requireEmailVerification` | Production posture. **The api refuses to boot with this on and no `secrets.smtp.host`** — an address cannot verify itself without mail, so every account on such an install is locked out, the first owner included. Turn it on in the same change as SMTP |
| `config.storageUsdPerGbMonth` | Your storage price, for the $/month ROI headline |
| `config.retentionDays` | Your ceiling on history, in days. Storage is your bill, so it caps both what is kept and what any plan may see. Empty means each plan's own window decides |
| `config.mongoMaxPoolSize` | Sockets the driver may open against **one** connected cluster — 10, against the driver's own default of 100. A session is held per cluster, so the worst case multiplies by the fleet, and the sockets are spent on the customer's mongod rather than ours. Surplus sockets are returned after 60s idle |
| `config.trustProxy` | **Required with `ingress.enabled`**, and nothing is inferred. The pod network's CIDR — `10.0.0.0/8` on many clusters, k3s `10.42.0.0/16`, Calico `192.168.0.0/16`, an EKS default VPC `172.31.0.0/16`. Prefer a range over `true`, which better-auth cannot attribute a forwarded header from. Narrow it: this is who may claim to be someone else, so on a CNI giving pods VPC addresses it is every workload in the VPC. An install whose proxy is arranged outside the chart still has to set it — `helm install` prints what it resolved |
| `config.rateLimitMax` / `config.authRateLimitMax` | Per-IP request budgets a minute. `rateLimitMax` is counted in each api process's memory, so it is **per replica**; `authRateLimitMax` is read twice — per replica for `/api/auth/*`, and by better-auth for the credential endpoints, which counts in Postgres and so applies to the whole deployment |
| `config.allowUntestedDatabaseVersion` | Lets a cluster on a major series newer than this release was probed against connect, whichever engine — MongoDB past 8.x, SQL Server past 2025, PostgreSQL past 18. One flag for all three, because it answers one question. Every engine's floor is not overridable; this is only the ceiling |
| `api.runCronjob` | Who owns the recurring schedule — the api always **executes** jobs; this decides **when** passes become due. `true` (default) runs a 30 s in-process tick per replica. `false` fires nothing on its own and opens `POST /api/internal/tick` instead, so an external scheduler is the clock: the request runs the whole tick — claims, enqueues and drains, answering within 25 s, where `"drained": false` means ping again to resume, and repeats are free because passes are claimed per occurrence. Requires `secrets.cronTriggerSecret`; the chart refuses `false` without one |
| `secrets.cronTriggerSecret` | The bearer token that endpoint demands, required when `api.runCronjob=false`. It authorises the whole pipeline and there is no user session behind it: `openssl rand -hex 32` |
| `config.signupMode` | `invite` (default), `open` or `closed`. The first account always bootstraps the install; after that invite-only. `open` lets any stranger register — and every account can make the control plane dial hosts it names |
| `config.allowPrivateClusterTargets` | Set `true` when the MongoDB you manage is on a private network (the normal self-hosted case). Leave `false` for anything strangers can reach, or accounts can probe your internal network. Cloud metadata stays blocked either way |
| `config.allowInsecureClusterTls` | Set `true` only when the MongoDB you manage genuinely serves no certificate and the network between is trusted. Every outbound connection requires validated TLS otherwise — including the ones the pipeline makes from stored credentials, so a cluster connected without it stops being collected and its owners are told why. Kept apart from `allowPrivateClusterTargets` on purpose: a VPC-peered or PrivateLink cluster is a private address that must still be forced to TLS |
| `metrics.enabled` | Prometheus metrics on port `metrics.port` (9464) for all three workloads. **Off by default** — an exporter costs memory in every process, and an install with nothing scraping it was paying that for nobody. Turn it on if anything is; the endpoint is never routed by the ingress |
| `metrics.serviceMonitor.enabled` | One Prometheus Operator ServiceMonitor per workload. Off by default — it needs the `monitoring.coreos.com` CRDs, and a chart that assumes them cannot install without them |
| `metrics.prometheusRule.enabled` | 18 alerting rules for the failures nothing else reports. Same CRD requirement, also off by default. Thresholds under `metrics.prometheusRule.thresholds` |

## Metrics

Off by default (`metrics.enabled=true` to serve it). With it on, all three
workloads serve `/metrics` on port 9464, and each answers for what only it can
see — scrape both:

| workload | reports |
|---|---|
| api | HTTP traffic; everything read from the control-plane database: clusters under management, recommendations by pipeline state (`HIDDEN` is a drop mid-observe), queue depth per task, the dead-letter backlog, the age of the oldest unclaimed job; and the pipeline itself — job outcomes and durations from graphile-worker's own events, per-cluster tick outcomes, how many clusters it currently cannot reach, regression-gate decisions, drops executed |
| web | page render time per route pattern, and the api as the dashboard server experiences it — including the calls it never answered, which the api itself cannot report and which the loaders otherwise swallow into an empty panel |

In single-container all of that is still served, and still separately: the
api's listener stays on 9464 and the dashboard's moves to 9465, because they are
now in one network namespace. Both Services publish 9464 either way, so scrape
`<release>-api` and `<release>-web` exactly as in `split` — they simply happen to
resolve to the same pod.

`metrics.serviceMonitor.enabled=true` installs a ServiceMonitor for each. Without
the Prometheus Operator, point your own scraper at the `metrics` port on
`<release>-api` and `<release>-web`, or look by hand:

```bash
kubectl -n indexterity port-forward svc/indexterity-api 9464:9464
curl -s localhost:9464/metrics | grep indexterity_
```

The endpoint carries **no authentication**, which is why it is a second port
rather than a route on the api: an ingress that publishes the api host does not
publish this, and cluster counts and pipeline state are operator information.
Keep it in-cluster. `metrics.enabled=false` turns it off entirely.

**If the ServiceMonitors do not appear as targets, it is the label selector**, not
the chart. A Prometheus Operator adopts only the ServiceMonitors matching its own
`serviceMonitorSelector` — usually `release: <your-stack-release>`. Ask it what it
wants, then match:

```bash
kubectl get prometheus -A -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.serviceMonitorSelector}{"\n"}{end}'
helm upgrade indexterity … --set metrics.serviceMonitor.labels.release=kube-prometheus-stack
```

### Alerts

`metrics.prometheusRule.enabled=true` installs a `PrometheusRule` with 18 alerts,
grouped by the question they answer: is the schedule running, is work piling up,
can we still reach the clusters, is the safety pipeline meaningful, is the control
plane healthy, and what are readers seeing. `metrics.prometheusRule.labels` is the
same escape hatch as above.

Every threshold is under `metrics.prometheusRule.thresholds`, and the
stale-schedule windows are derived from `BURST_SCHEDULE` in
`apps/api/src/jobs/schedule.ts` — if that schedule changes, these move with it.

Two of them exist because the obvious rule does not work:

- **`IndexterityWorkerNotReporting`** (the name predates #232 folding the worker
  into the api; the alert outlives it) uses `absent_over_time`, not `increase`.
  When a process dies its series go stale, so `increase(...) == 0` matches nothing
  and a rule written that way is silent in exactly the case you care about most.
- **The stale-schedule alerts watch the `schedule*` dispatchers**, not the
  per-cluster tasks. `scheduleCollect` ticks on cron whether or not a cluster
  exists; `collect` does not, so alerting on it fires the moment the last cluster
  is offboarded.

## Security defaults

Onboarding dials whatever connection string a user supplies, so two defaults
are deliberately restrictive (see the wiki's [Architecture](https://github.com/FullmetalBober/Indexterity/wiki/Architecture)
page, under Security):

- **Sign-up is invite-only.** First account bootstraps; the rest need an invite.
- **Private and loopback targets are refused.** Self-hosted installs whose
  database lives on the cluster network must set
  `config.allowPrivateClusterTargets=true`. Link-local/cloud-metadata,
  multicast and reserved ranges are refused regardless.
- **Plaintext connections are refused**, and so is TLS whose certificate cannot
  be verified. `config.allowInsecureClusterTls=true` is the way out, and it is a
  separate switch from the one above for a reason: an address being private says
  nothing about whether its transport should be encrypted. Skipping a *specific*
  certificate check for one cluster — a private CA, an SSH tunnel — is a
  per-cluster checkbox on the connect form instead, and needs no chart setting.

`helm install` prints a warning when the chosen combination is unsafe.

## Notes on the workloads

- **api and web default to one replica each.** The common install is a single
  organization managing its own clusters, where a second pod is memory spent on
  availability nobody asked for. The cost is that a node drain, an eviction or an
  OOMKill is a gap in service rather than a lost replica — rolling upgrades are
  unaffected, since a Deployment at one replica surges before it terminates.
- **Both scale horizontally when you want that.** They are stateless and sessions
  live in Postgres, so `api.replicas` and `web.replicas` are the only change.
  Two things move with them: `config.rateLimitMax` is counted per api process, so
  the real ceiling multiplies (`config.authRateLimitMax` does not — better-auth's
  half counts in Postgres), and each api replica adds roughly 10 Postgres
  connections. In single-container they scale as one unit, on `api.replicas`.
- **The api settles an in-flight drain before its pools close on `SIGTERM`**
  (`terminationGracePeriodSeconds: 60`) — a rollout mid-tick loses no job, it
  retries on the next tick.

## Validating changes to this chart

```bash
helm lint deploy/helm/indexterity
helm template rel deploy/helm/indexterity --set secrets.existingSecret=s | kubeconform -strict -
```

Rendering is not installing, and the topologies are where that gap is widest — a
merged pod that renders can still bind a port twice or leave a Service with no
endpoints. `deploy/kind-test.sh` installs into a throwaway Kind cluster and runs
the same assertions against each packaging; CI runs both in parallel on any
change under `deploy/`:

```bash
deploy/kind-test.sh                          # split, the default
TOPOLOGY=single-container deploy/kind-test.sh
```

The alert rules need their own check — a typo'd expression installs cleanly and
then never fires, which `helm lint` and `kubeconform` both accept. CI runs this on
every chart change:

```bash
helm template rel deploy/helm/indexterity --set secrets.existingSecret=s \
  --set metrics.prometheusRule.enabled=true \
  | yq 'select(.kind == "PrometheusRule") | {"groups": .spec.groups}' > /tmp/rules.yaml
docker run --rm --entrypoint promtool -v /tmp/rules.yaml:/rules.yaml:ro \
  prom/prometheus:v3.6.0 check rules /rules.yaml
```
