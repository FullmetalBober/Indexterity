# Indexterity Helm chart

Deploys the three workloads — **api**, **web** (dashboard) and **worker**
(scheduler) — from two images, plus a pre-upgrade migration job. `topology`
folds the first two into one pod, or one container, when three Deployments is
more than an install needs.

PostgreSQL is **not** bundled: point `secrets.databaseUrl` at a managed
instance or your own postgres release. That is the control-plane store; the
MongoDB clusters Indexterity manages are added later from the dashboard.

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
  --set ingress.tls.secretName=indexterity-tls

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
| `split` (default) | Three Deployments. api, web and worker roll, scale and fail independently — an api rollout cannot take the landing page down with it. What the hosted install runs | api, web |
| `single-pod` | One Deployment for the serving tier: an **api container and a web container in one pod**, the dashboard reaching the api over `127.0.0.1`. The worker keeps its own Deployment unless you embed it | api, web |
| `single-container` | One Deployment, **one container**, from the all-in-one image: both processes under a supervisor that is PID 1 | all-in-one |

```bash
# One pod, two containers. Nothing new to build — the two published images.
helm install indexterity … --set topology=single-pod

# One container, everything in it, including the scheduler.
helm install indexterity … \
  --set topology=single-container \
  --set worker.enabled=false --set api.runWorker=true --set api.replicas=1
```

What the merged topologies cost, and it is the same trade twice:

- **One failure domain.** api and web scale together (`api.replicas` counts the
  pods; `web.replicas` is ignored), and a dashboard change rolls the api with it.
- **The web metrics listener moves to `metrics.port + 1`** — one network
  namespace cannot bind one port twice. Both Services still *publish* 9464, so
  scrapers and `port-forward` read the same number as before; only the
  containerPort moved. `metrics.webPort` overrides it.
- **The worker is a separate decision.** Merging the serving tier does not touch
  the schedule. `worker.enabled=false` with `api.runWorker=true` (and
  `api.replicas=1`) is what makes a merged topology genuinely one workload; the
  chart refuses the combinations that would install the crontab twice.

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

The supervisor (`deploy/all-in-one/supervisor.mjs`) splits the two variables the
processes would otherwise fight over — `WEB_METRICS_PORT` (default
`METRICS_PORT + 1`) and `WEB_SENTRY_DSN` (default: the api's project) — forwards
`SIGTERM` to both, and **exits non-zero the moment either process does**, so the
host restarts the container instead of leaving a dashboard serving 502s from a
passthrough with nothing behind it. `RUN_WORKER` defaults to `true` in this image
and nowhere else: a single container has nowhere else to put the scheduler.

## Back up MASTER_KEY

Every customer connection string is sealed with `MASTER_KEY` (envelope
encryption). **If it is lost, no connected cluster can be reached again** and
each one must be re-onboarded. Store it outside the cluster. To rotate, add
`MASTER_KEY_V2` via `secrets.existingSecret` and set
`secrets.masterKeyVersion=2`; rows sealed with v1 stay readable.

## What talks to what

```
                     ┌── /api ──► api ──► PostgreSQL
browser ──► ingress ─┤              ▲        ▲
                     └── /  ───► web ┘       │   (SSR reads, in-cluster Service)
                                 └──────┘    │   (and /api if no ingress rule)
                                  worker ────┴──► customer MongoDB clusters
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
| `topology` | `split` (default), `single-pod` or `single-container` — see above. Packaging only; the Services, the ingress and the app are the same in all three |
| `allInOne.*` | Image and resources for `topology: single-container`. `api.image` and `web.image` are never pulled in that topology, and neither is a second copy of node |
| `metrics.webPort` | The dashboard's metrics containerPort. Empty means `metrics.port`, or `metrics.port + 1` when it shares a network namespace with the api |
| `secrets.existingSecret` | Bring your own Secret (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `MASTER_KEY`, optionally `SMTP_PASS`, `GITHUB_CLIENT_SECRET`) instead of putting values in Helm |
| `web.publicUrl` | The dashboard's public origin. Defaults to the ingress host; the api trusts it for auth and session cookies are bound to it |
| `worker.enabled` | Off means nothing is collected, applied or finalized on a schedule — the dashboard still works and can collect on demand |
| `migrations.enabled` | The pre-install/pre-upgrade Job runs `node dist/migrate.js` before new pods start. Disable only if you migrate out of band |
| `smtp.*` | Without a host, invites, alerts, verification and reset mails are logged and dropped |
| `config.requireEmailVerification` | Production posture — needs working SMTP, or nobody can sign in |
| `config.storageUsdPerGbMonth` | Your storage price, for the $/month ROI headline |
| `config.retentionDays` | Your ceiling on history, in days. Storage is your bill, so it caps both what is kept and what any plan may see. Empty means each plan's own window decides |
| `config.rateLimitMax` / `config.authRateLimitMax` | Per-IP request budgets a minute. `rateLimitMax` is counted in each api process's memory, so it is **per replica**; `authRateLimitMax` is read twice — per replica for `/api/auth/*`, and by better-auth for the credential endpoints, which counts in Postgres and so applies to the whole deployment |
| `config.allowUntestedMongoVersion` | Lets a cluster on a MongoDB major series newer than this release was tested against connect. The floor is not overridable; this is the ceiling |
| `api.runWorker` | Embed the job runner in the api, for a single-replica install that sets `worker.enabled=false`. Leave `false` otherwise — with the worker Deployment on, or with more than one api replica, the cron schedule would be installed more than once |
| `config.signupMode` | `invite` (default), `open` or `closed`. The first account always bootstraps the install; after that invite-only. `open` lets any stranger register — and every account can make the control plane dial hosts it names |
| `config.allowPrivateClusterTargets` | Set `true` when the MongoDB you manage is on a private network (the normal self-hosted case). Leave `false` for anything strangers can reach, or accounts can probe your internal network. Cloud metadata stays blocked either way |
| `config.allowInsecureClusterTls` | Set `true` only when the MongoDB you manage genuinely serves no certificate and the network between is trusted. Every outbound connection requires validated TLS otherwise — including the ones the worker makes from stored credentials, so a cluster connected without it stops being collected and its owners are told why. Kept apart from `allowPrivateClusterTargets` on purpose: a VPC-peered or PrivateLink cluster is a private address that must still be forced to TLS |
| `metrics.enabled` | Prometheus metrics on port `metrics.port` (9464) for all three workloads. On by default; the endpoint is never routed by the ingress |
| `metrics.serviceMonitor.enabled` | One Prometheus Operator ServiceMonitor per workload. Off by default — it needs the `monitoring.coreos.com` CRDs, and a chart that assumes them cannot install without them |
| `metrics.prometheusRule.enabled` | 18 alerting rules for the failures nothing else reports. Same CRD requirement, also off by default. Thresholds under `metrics.prometheusRule.thresholds` |

## Metrics

All three workloads serve `/metrics` on port 9464, and each answers for what only
it can see — scrape all three:

| workload | reports |
|---|---|
| api | HTTP traffic, and everything read from the control-plane database: clusters under management, recommendations by pipeline state (`HIDDEN` is a drop mid-observe), queue depth per task, the dead-letter backlog, the age of the oldest unclaimed job |
| worker | job outcomes and durations from graphile-worker's own events, per-cluster tick outcomes, how many clusters it currently cannot reach, regression-gate decisions, drops executed |
| web | page render time per route pattern, and the api as the dashboard server experiences it — including the calls it never answered, which the api itself cannot report and which the loaders otherwise swallow into an empty panel |

With `worker.enabled=false` and `RUN_WORKER=true` on the api instead, the api
serves the worker's half as well.

In the merged topologies all of that is still served, and still separately: the
api's listener stays on 9464 and the dashboard's moves to 9465, because they are
now in one network namespace. Both Services publish 9464 either way, so scrape
`<release>-api` and `<release>-web` exactly as in `split` — they simply happen to
resolve to the same pod.

`metrics.serviceMonitor.enabled=true` installs a ServiceMonitor for each. Without
the Prometheus Operator, point your own scraper at the `metrics` port on
`<release>-api`, `<release>-web` and `<release>-worker-metrics`, or look by hand:

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
stale-schedule windows are derived from the crontab in `apps/api/src/jobs/runner.ts`
— if that schedule changes, these move with it.

Two of them exist because the obvious rule does not work:

- **`IndexterityWorkerNotReporting`** uses `absent_over_time`, not `increase`. When
  a process dies its series go stale, so `increase(...) == 0` matches nothing and a
  rule written that way is silent in exactly the case you care about most.
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

- **worker runs exactly one replica.** graphile-worker coordinates execution
  through Postgres, but every replica would install the crontab, so a second
  pod means duplicate scheduling. Scale job throughput with
  `worker.concurrency` instead.
- **api and web scale horizontally.** Both are stateless; sessions live in
  Postgres. In a merged topology they scale as one unit, on `api.replicas`.
- The worker drains its connection pool on `SIGTERM`
  (`terminationGracePeriodSeconds: 60`).
- **The worker's only Service is `-worker-metrics`**, and it is headless. Nothing
  calls the worker; it exists so a scrape can find the pod.

## Validating changes to this chart

```bash
helm lint deploy/helm/indexterity
helm template rel deploy/helm/indexterity --set secrets.existingSecret=s | kubeconform -strict -
```

Rendering is not installing, and the topologies are where that gap is widest — a
merged pod that renders can still bind a port twice or leave a Service with no
endpoints. `deploy/kind-test.sh` installs into a throwaway Kind cluster and runs
the same assertions against each packaging; CI runs all three in parallel on any
change under `deploy/`:

```bash
TOPOLOGY=single-pod deploy/kind-test.sh
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
