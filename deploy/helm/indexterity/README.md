# Indexterity Helm chart

Deploys the three workloads — **api**, **web** (dashboard) and **worker**
(scheduler) — from two images, plus a pre-upgrade migration job.

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
`WEB_ORIGIN` are read at runtime (the dashboard's server functions are the only
thing that talks to the api).

## Back up MASTER_KEY

Every customer connection string is sealed with `MASTER_KEY` (envelope
encryption). **If it is lost, no connected cluster can be reached again** and
each one must be re-onboarded. Store it outside the cluster. To rotate, add
`MASTER_KEY_V2` via `secrets.existingSecret` and set
`secrets.masterKeyVersion=2`; rows sealed with v1 stay readable.

## What talks to what

```
browser ──► ingress ──► web (SSR + server functions) ──► api ──► PostgreSQL
                                                          ▲         ▲
                                                worker ───┘─────────┘
                                                   │
                                                   └──► customer MongoDB clusters
```

The api never needs to be public: browsers only reach the dashboard, whose
server functions call the api over the in-cluster Service. Enable
`ingress.api.*` only if you want programmatic API access.

## Values worth knowing

| Value | Why it matters |
|---|---|
| `secrets.existingSecret` | Bring your own Secret (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `MASTER_KEY`, optionally `SMTP_PASS`, `GITHUB_CLIENT_SECRET`) instead of putting values in Helm |
| `web.publicUrl` | The dashboard's public origin. Defaults to the ingress host; the api trusts it for auth and session cookies are bound to it |
| `worker.enabled` | Off means nothing is collected, applied or finalized on a schedule — the dashboard still works and can collect on demand |
| `migrations.enabled` | The pre-install/pre-upgrade Job runs `node dist/migrate.js` before new pods start. Disable only if you migrate out of band |
| `smtp.*` | Without a host, invites, alerts, verification and reset mails are logged and dropped |
| `config.requireEmailVerification` | Production posture — needs working SMTP, or nobody can sign in |
| `config.storageUsdPerGbMonth` | Your storage price, for the $/month ROI headline |
| `config.signupMode` | `invite` (default), `open` or `closed`. The first account always bootstraps the install; after that invite-only. `open` lets any stranger register — and every account can make the control plane dial hosts it names |
| `config.allowPrivateClusterTargets` | Set `true` when the MongoDB you manage is on a private network (the normal self-hosted case). Leave `false` for anything strangers can reach, or accounts can probe your internal network. Cloud metadata stays blocked either way |
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
are deliberately restrictive (see `docs/architecture.md` §10.2):

- **Sign-up is invite-only.** First account bootstraps; the rest need an invite.
- **Private and loopback targets are refused.** Self-hosted installs whose
  database lives on the cluster network must set
  `config.allowPrivateClusterTargets=true`. Link-local/cloud-metadata,
  multicast and reserved ranges are refused regardless.

`helm install` prints a warning when the chosen combination is unsafe.

## Notes on the workloads

- **worker runs exactly one replica.** graphile-worker coordinates execution
  through Postgres, but every replica would install the crontab, so a second
  pod means duplicate scheduling. Scale job throughput with
  `worker.concurrency` instead.
- **api and web scale horizontally.** Both are stateless; sessions live in
  Postgres.
- The worker drains its connection pool on `SIGTERM`
  (`terminationGracePeriodSeconds: 60`).
- **The worker's only Service is `-worker-metrics`**, and it is headless. Nothing
  calls the worker; it exists so a scrape can find the pod.

## Validating changes to this chart

```bash
helm lint deploy/helm/indexterity
helm template rel deploy/helm/indexterity --set secrets.existingSecret=s | kubeconform -strict -
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
