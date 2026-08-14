{{/* Base name, overridable. */}}
{{- define "indexterity.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "indexterity.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "indexterity.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "indexterity.labels" -}}
helm.sh/chart: {{ include "indexterity.chart" . }}
app.kubernetes.io/name: {{ include "indexterity.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: indexterity
{{- end -}}

{{/* Selector labels for one component: include "indexterity.selectorLabels" (dict "root" . "component" "api") */}}
{{- define "indexterity.selectorLabels" -}}
app.kubernetes.io/name: {{ include "indexterity.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "indexterity.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "indexterity.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The Secret holding DATABASE_URL / BETTER_AUTH_SECRET / MASTER_KEY. */}}
{{- define "indexterity.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "indexterity.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "indexterity.apiImage" -}}
{{- printf "%s:%s" .Values.api.image.repository (default .Chart.AppVersion .Values.api.image.tag) -}}
{{- end -}}

{{- define "indexterity.webImage" -}}
{{- printf "%s:%s" .Values.web.image.repository (default .Chart.AppVersion .Values.web.image.tag) -}}
{{- end -}}

{{- define "indexterity.allInOneImage" -}}
{{- printf "%s:%s" .Values.allInOne.image.repository (default .Chart.AppVersion .Values.allInOne.image.tag) -}}
{{- end -}}

{{/*
Whichever image carries the api build — for the workloads that run one of its
other entrypoints, the migration and the worker. The all-in-one image contains
the same apps/api/dist, so in single-container the whole release pulls exactly one
image, which is the reason to be in that topology in the first place.
*/}}
{{- define "indexterity.apiRuntimeImage" -}}
{{- if eq .Values.topology "single-container" -}}
{{- include "indexterity.allInOneImage" . -}}
{{- else -}}
{{- include "indexterity.apiImage" . -}}
{{- end -}}
{{- end -}}

{{- define "indexterity.apiRuntimePullPolicy" -}}
{{- if eq .Values.topology "single-container" -}}
{{- .Values.allInOne.image.pullPolicy -}}
{{- else -}}
{{- .Values.api.image.pullPolicy -}}
{{- end -}}
{{- end -}}

{{/*
Whether the api and the web server share a pod — true for single-container,
empty (falsey to `if`) for the default. There is one merged shape, so this is
the same question as `eq .Values.topology "single-container"`; it stays a named
predicate because five templates ask it, and one definition is what stops them
disagreeing about what merged implies — one pod, one loopback hop, two metrics
ports.
*/}}
{{- define "indexterity.merged" -}}
{{- if eq .Values.topology "single-container" -}}true{{- end -}}
{{- end -}}

{{/*
Which POD answers for a workload: include "indexterity.podComponent" (dict "root" . "workload" "web").

Merged, the api and the web server are one pod and it cannot carry two component
labels, so it carries `app` and both Services select that. The Services keep
their own api/web labels — the ServiceMonitors select Services, so they, the
ingress and every in-cluster caller are unaffected by the topology.
*/}}
{{- define "indexterity.podComponent" -}}
{{- if and (include "indexterity.merged" .root) (has .workload (list "api" "web")) }}app{{ else }}{{ .workload }}{{ end -}}
{{- end -}}

{{/* In-cluster api base URL — what better-auth defaults to. */}}
{{- define "indexterity.internalApiUrl" -}}
{{- printf "http://%s-api:%v" (include "indexterity.fullname" .) .Values.api.service.port -}}
{{- end -}}

{{/*
Where the WEB SERVER reaches the api. Merged, that is the container beside it (or
in single-container the process beside it), so the loopback address rather than
the Service: same pod, no kube-proxy, and it keeps answering while the Service
has no ready endpoints — which during a rollout is exactly when the dashboard is
being asked to render.
*/}}
{{- define "indexterity.webApiUrl" -}}
{{- if .Values.web.apiUrl -}}
{{- .Values.web.apiUrl -}}
{{- else if include "indexterity.merged" . -}}
{{- printf "http://127.0.0.1:%v" .Values.api.port -}}
{{- else -}}
{{- include "indexterity.internalApiUrl" . -}}
{{- end -}}
{{- end -}}

{{/*
The port the web server serves /metrics on. One number in the default topology,
where it is alone in its network namespace; merged, the api has already bound
metrics.port in that namespace, so the second listener has to move or the
dashboard container crash-loops on EADDRINUSE.

Only the containerPort and this variable move. Both Services still publish
metrics.port, because they are different Services — so scrapers, the chart's own
test and the port-forward in NOTES.txt all read the same number they did before.
*/}}
{{- define "indexterity.webMetricsPort" -}}
{{- if .Values.metrics.webPort -}}
{{- .Values.metrics.webPort -}}
{{- else if include "indexterity.merged" . -}}
{{- add .Values.metrics.port 1 -}}
{{- else -}}
{{- .Values.metrics.port -}}
{{- end -}}
{{- end -}}

{{/* The dashboard's public origin: explicit value, else derived from the ingress host. */}}
{{- define "indexterity.webOrigin" -}}
{{- if .Values.web.publicUrl -}}
{{- .Values.web.publicUrl -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- else -}}
{{- printf "http://%s-web:%v" (include "indexterity.fullname" .) .Values.web.service.port -}}
{{- end -}}
{{- end -}}

{{/* Env shared by every workload that talks to Postgres or seals credentials. */}}
{{- define "indexterity.coreEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "indexterity.secretName" . }}
      key: DATABASE_URL
- name: MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "indexterity.secretName" . }}
      key: MASTER_KEY
{{- if .Values.secrets.masterKeyVersion }}
- name: MASTER_KEY_VERSION
  value: {{ .Values.secrets.masterKeyVersion | quote }}
{{- end }}
{{- /* The rotation's keys, from the Secret rather than inline: these are KEKs.
      Ranged over the same map the Secret renders, so a version present in one is
      present in the other — a key in the Secret that no container reads is a
      rotation that looks configured and decrypts nothing. With
      `existingSecret`, name the versions in secrets.masterKeys anyway (values
      may be empty): the keys are read from your Secret, this only says which
      ones to mount. */}}
{{- range $version, $key := .Values.secrets.masterKeys }}
- name: MASTER_KEY_V{{ $version }}
  valueFrom:
    secretKeyRef:
      name: {{ include "indexterity.secretName" $ }}
      key: MASTER_KEY_V{{ $version }}
{{- end }}
- name: DEFAULT_ORG_PLAN
  value: {{ .Values.config.defaultOrgPlan | quote }}
- name: LOG_LEVEL
  value: {{ .Values.config.logLevel | quote }}
- name: ALLOW_PRIVATE_CLUSTER_TARGETS
  value: {{ .Values.config.allowPrivateClusterTargets | quote }}
# Sockets opened against ONE connected cluster. Held per cluster, so the worst
# case multiplies by the fleet — and they are spent on the customer's mongod.
- name: MONGO_MAX_POOL_SIZE
  value: {{ .Values.config.mongoMaxPoolSize | quote }}
# Postgres connections PER POOL. The api holds three (requests, jobs, auth), kept
# apart so a slow read cannot starve a sign-in — so size postgres for this times
# the pools, plus graphile-worker's own.
- name: PG_POOL_MAX
  value: {{ .Values.config.pgPoolMax | quote }}
- name: ALLOW_INSECURE_CLUSTER_TLS
  value: {{ .Values.config.allowInsecureClusterTls | quote }}
{{- if .Values.config.allowUntestedMongoVersion }}
- name: ALLOW_UNTESTED_MONGO_VERSION
  value: "true"
{{- end }}
{{- if .Values.config.retentionDays }}
- name: RETENTION_DAYS
  value: {{ .Values.config.retentionDays | quote }}
{{- end }}
{{- end -}}

{{/*
A Kubernetes memory quantity in bytes, or empty when it is not a shape this
understands — in which case the caller leaves the heap alone rather than guessing.
*/}}
{{- define "indexterity.memoryBytes" -}}
{{- $q := . | toString | trim -}}
{{- if regexMatch "^[0-9]+$" $q -}}
{{- $q -}}
{{- else if regexMatch "^[0-9]+Ki$" $q -}}
{{- mul (trimSuffix "Ki" $q | int64) 1024 -}}
{{- else if regexMatch "^[0-9]+Mi$" $q -}}
{{- mul (trimSuffix "Mi" $q | int64) 1048576 -}}
{{- else if regexMatch "^[0-9]+Gi$" $q -}}
{{- mul (trimSuffix "Gi" $q | int64) 1073741824 -}}
{{- else if regexMatch "^[0-9]+M$" $q -}}
{{- mul (trimSuffix "M" $q | int64) 1000000 -}}
{{- else if regexMatch "^[0-9]+G$" $q -}}
{{- mul (trimSuffix "G" $q | int64) 1000000000 -}}
{{- end -}}
{{- end -}}

{{/*
NODE_OPTIONS capping V8's old space, for a container running ONE node process:
include "indexterity.heapEnv" (dict "limit" .Values.web.resources.limits.memory)

This is not an optimisation, it is a safety cap, and it is needed because node's
own sizing stops helping exactly where this chart now sits. V8 derives its default
ceiling from the container's limit — but only downwards to a point. Measured on
node 26: a 1 GiB limit gives a 536 MB ceiling and 512 MiB gives 268 MB, then it
FLATTENS — 384 MiB, 320 MiB, 256 MiB, 192 MiB and 96 MiB all give ~262 MB. So at
any limit at or below 256 MiB the process believes it may hold more heap than the
cgroup allows, and a heap-heavy pass is killed for memory instead of collected.

65% of the limit, and the rest is deliberately unallocated: a heap ceiling is not
a process's memory. Node's own code and stacks live outside it, and so does the
~32 MB scrypt allocates per password hash in flight — bounded by libuv's
threadpool (four by default), not by the rate limits.

Nothing is emitted when the share works out below 64 MB, or when the limit is
absent or in a shape this cannot read. A heap that small collects instead of
serving, and an operator who set a limit that low against a node process has a
bigger problem than the ceiling — so node's own sizing is left in place, and with
it the chance of being OOMKilled that this define otherwise removes.

Emitted before extraEnv, so an operator's own NODE_OPTIONS there wins.
*/}}
{{- define "indexterity.heapEnv" -}}
{{- $bytes := include "indexterity.memoryBytes" (default "" .limit) -}}
{{- if $bytes -}}
{{- $mb := div (mul ($bytes | int64) 65) 104857600 -}}
{{- if ge $mb 64 -}}
# V8's default ceiling does not scale below a 512Mi limit (it flattens at ~262MB),
# so at this limit the heap has to be capped explicitly or the container is
# OOMKilled where it should have collected.
- name: NODE_OPTIONS
  value: {{ printf "--max-old-space-size=%v" $mb | quote }}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The metrics endpoint. Takes the listener's port as `port` because a merged pod
     serves two of them from one network namespace:
     include "indexterity.metricsEnv" (dict "root" . "port" .Values.metrics.port). */}}
{{- define "indexterity.metricsEnv" -}}
{{- if .root.Values.metrics.enabled }}
- name: METRICS_ENABLED
  value: "true"
- name: METRICS_PORT
  value: {{ .port | quote }}
{{- end }}
{{- end -}}

{{/*
The dashboard server's own variables (schema: apps/web/src/lib/env.ts), in a
helper because two topologies render them: its own Deployment, and the merged pod
where they sit beside the api's.

`shared` says the api's env block is in the SAME container — single-container,
where one process list reads one environment. WEB_ORIGIN and TRUST_PROXY are
dropped there because the api already sets both from the same helpers, and two
entries of one name in one container is a value that depends on ordering.
*/}}
{{- define "indexterity.webEnv" -}}
- name: PORT
  value: {{ .root.Values.web.port | quote }}
# The web SERVER's own reads during SSR, and its /api passthrough. Read at
# runtime so one image deploys everywhere. The browser does not use this and is
# not told it: it calls /api on the origin that served the page.
- name: API_URL
  value: {{ include "indexterity.webApiUrl" .root | quote }}
{{- if not .shared }}
- name: WEB_ORIGIN
  value: {{ include "indexterity.webOrigin" .root | quote }}
# Only read when this pod answers /api itself — which it does when the ingress
# has no /api rule. Same switch and same reasoning as the api's: forwarding a
# header the client could have written lets a caller pick its own address and
# never reach a rate limit, so it is off unless something in front is known to
# set it.
- name: TRUST_PROXY
  value: {{ include "indexterity.trustProxy" .root | quote }}
{{- end }}
{{- with .root.Values.web.siteUrl }}
# Canonical/og:url override for forks and indexed staging copies.
- name: SITE_URL
  value: {{ . | quote }}
{{- end }}
{{- with .root.Values.web.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end -}}

{{/* Error reporting. Takes the workload's own DSN as `dsn` because the api and the
     worker report to one Sentry project and the dashboard to another — every process
     reads a plain SENTRY_DSN, and which project that is belongs to the deployment.
     Off unless a DSN is given, and it is the OPERATOR's: this chart never defaults
     to reporting anywhere.

     A plain value rather than a Secret key: a DSN is an ingest identifier, not a
     credential — it can only write events, which is why Sentry's own browser SDKs
     ship it publicly. */}}
{{- define "indexterity.errorsEnv" -}}
{{- if .dsn }}
- name: SENTRY_DSN
  value: {{ .dsn | quote }}
- name: SENTRY_ENVIRONMENT
  value: {{ default .root.Release.Namespace .root.Values.errorReporting.environment | quote }}
{{- end }}
{{- end -}}

{{/* SMTP + storage pricing — shared by the api (mail, ROI) and worker (alerts, digest). */}}
{{- define "indexterity.mailEnv" -}}
{{- if .Values.smtp.host }}
- name: SMTP_HOST
  value: {{ .Values.smtp.host | quote }}
- name: SMTP_PORT
  value: {{ .Values.smtp.port | quote }}
- name: SMTP_USER
  value: {{ .Values.smtp.user | quote }}
- name: SMTP_PASS
  valueFrom:
    secretKeyRef:
      name: {{ include "indexterity.secretName" . }}
      key: SMTP_PASS
- name: MAIL_FROM
  value: {{ default .Values.smtp.user .Values.smtp.from | quote }}
{{- end }}
{{- if .Values.config.storageUsdPerGbMonth }}
- name: STORAGE_USD_PER_GB_MONTH
  value: {{ .Values.config.storageUsdPerGbMonth | quote }}
{{- end }}
{{- end -}}

{{/* Fail early with an actionable message when a required secret is absent. */}}
{{- define "indexterity.validateSecrets" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- if not .Values.secrets.databaseUrl -}}
{{- fail "secrets.databaseUrl is required (or set secrets.existingSecret). Example: postgres://user:pass@host:5432/indexterity" -}}
{{- end -}}
{{- if not .Values.secrets.betterAuthSecret -}}
{{- fail "secrets.betterAuthSecret is required (or set secrets.existingSecret). Generate one: openssl rand -base64 32" -}}
{{- end -}}
{{- if not .Values.secrets.masterKey -}}
{{- fail "secrets.masterKey is required (or set secrets.existingSecret). Generate one: openssl rand -base64 32 — losing it makes every stored connection string unreadable" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The api's own variables — everything it reads that is not shared with the worker
(coreEnv, mailEnv) or parameterised per listener (metricsEnv, errorsEnv). Those
four stay at the call site rather than nesting here, because they are also the
worker's and the migration's, and one flat list per container is what makes the
env homes readable (apps/api/src/config/homes.test.ts).
*/}}
{{- define "indexterity.apiEnv" -}}
- name: API_PORT
  value: {{ .Values.api.port | quote }}
# Browser auth requests arrive through the dashboard's server functions, which
# send this origin — better-auth must trust it.
- name: WEB_ORIGIN
  value: {{ include "indexterity.webOrigin" . | quote }}
# Only the api serves auth, so the signing key lives here rather than in the
# shared core env. It was written into the Secret and never referenced by any
# container — the api could not boot.
- name: BETTER_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "indexterity.secretName" . }}
      key: BETTER_AUTH_SECRET
- name: BETTER_AUTH_URL
  value: {{ include "indexterity.betterAuthUrl" . | quote }}
{{- if .Values.config.allowInsecureAuthUrl }}
- name: ALLOW_INSECURE_AUTH_URL
  value: "true"
{{- end }}
- name: TRUST_PROXY
  value: {{ include "indexterity.trustProxy" . | quote }}
# Per-IP request budgets, per minute and PER REPLICA — the counters live in each
# api process's memory, so two replicas allow twice this and a rolling deploy
# hands every bucket back at zero.
- name: RATE_LIMIT_MAX
  value: {{ .Values.config.rateLimitMax | quote }}
- name: AUTH_RATE_LIMIT_MAX
  value: {{ .Values.config.authRateLimitMax | quote }}
# One-container mode for the job runner. Off while the worker Deployment is on,
# or the schedule would be installed twice — validateWorkerTopology refuses that
# combination rather than letting it install.
- name: RUN_WORKER
  value: {{ .Values.api.runWorker | quote }}
- name: REQUIRE_EMAIL_VERIFICATION
  value: {{ .Values.config.requireEmailVerification | quote }}
- name: SIGNUP_MODE
  value: {{ .Values.config.signupMode | quote }}
- name: REQUIRE_OWNER_2FA
  value: {{ .Values.config.requireOwnerTwoFactor | quote }}
{{- if .Values.secrets.github.clientId }}
- name: GITHUB_CLIENT_ID
  value: {{ .Values.secrets.github.clientId | quote }}
- name: GITHUB_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "indexterity.secretName" . }}
      key: GITHUB_CLIENT_SECRET
{{- end }}
{{- with .Values.api.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end -}}

{{/*
Fail on a topology nobody implements, rather than rendering the default and
leaving the operator to work out from `kubectl get deploy` that their value was a
typo. `single_container` and `singleContainer` are the spellings that get tried.
*/}}
{{- define "indexterity.validateTopology" -}}
{{- if not (has .Values.topology (list "split" "single-container")) -}}
{{- fail (printf "topology is %q — it must be \"split\" (three Deployments) or \"single-container\" (one pod, one all-in-one container)" .Values.topology) -}}
{{- end -}}
{{- end -}}

{{/*
The crontab is installed by whoever runs the job runner, and graphile-worker
schedules it per process rather than per cluster — so two runners mean every
scheduled job is enqueued twice. Both halves of that were prose in values.yaml
and nothing enforced either. A merged topology is where an operator meets them:
folding three Deployments into one is exactly when worker.enabled comes off and
api.runWorker goes on, and doing only the second is silent.
*/}}
{{- define "indexterity.validateWorkerTopology" -}}
{{- if .Values.api.runWorker -}}
{{- if .Values.worker.enabled -}}
{{- fail "api.runWorker=true with worker.enabled=true installs the cron schedule twice — every collect, apply, retention and digest would be enqueued by both. Set worker.enabled=false to embed the runner in the api, or api.runWorker=false to keep the separate Deployment." -}}
{{- end -}}
{{- if gt (int .Values.api.replicas) 1 -}}
{{- fail (printf "api.runWorker=true with api.replicas=%v installs the cron schedule once per replica. The embedded runner is for a single-replica install; scale out with worker.enabled=true and api.runWorker=false instead." .Values.api.replicas) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
better-auth's baseURL. Defaults to the dashboard's own public origin, not the
in-cluster api Service: that Service is http, and the api refuses to boot on an
http baseURL in production because the session cookie's Secure flag rides on it
— a chart that defaulted to it could never install. The cookie ends up on the
web origin anyway (the dashboard proxies auth), so that is the honest value.
*/}}
{{- define "indexterity.betterAuthUrl" -}}
{{- default (include "indexterity.webOrigin" .) .Values.config.betterAuthUrl -}}
{{- end -}}

{{/*
Fail at render time rather than in CrashLoopBackOff. A non-https auth URL means
either the ingress is not wired for TLS or this is a cluster with no TLS at all;
the second is legitimate for a local smoke test and has to be said out loud.
*/}}
{{- define "indexterity.validateAuthUrl" -}}
{{- $url := include "indexterity.betterAuthUrl" . -}}
{{- if not (hasPrefix "https://" $url) -}}
{{- if not .Values.config.allowInsecureAuthUrl -}}
{{- fail (printf "the auth base URL is %q, and the api refuses a non-https one in production because the session cookie's Secure flag depends on it. Set web.publicUrl (or config.betterAuthUrl) to your https origin, or set config.allowInsecureAuthUrl=true for a cluster that terminates no TLS at all." $url) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
TRUST_PROXY, verbatim. It used to be inferred from ingress.enabled, and that was
wrong in both directions.

With an ingress and no explicit value it emitted `"true"` — the one dialect
values.yaml warns against eight lines above the knob. Fastify accepts it, but
better-auth resolves a client address only from a forwarded header it can
attribute, and with `"true"` it believes X-Forwarded-For only when the header
carries a SINGLE address, which it never does once an ingress has appended
itself. So the chart's default happy path produced exactly the shared auth
bucket D41 exists to have fixed.

Without one it emitted `"false"`, which is only right if nothing is in front —
and routing lives outside the chart often enough that this cannot be assumed. A
Traefik IngressRoute pointing at the -web Service is a proxy the chart never
sees, and every request then carries the proxy's pod address as its socket
address: one bucket again, silently.

`ingress.enabled` is not evidence about what sits in front of the api, so
nothing is inferred from it. validateTrustProxy below refuses the one case the
chart can prove is proxied; NOTES.txt reports the effective value for the rest.
*/}}
{{- define "indexterity.trustProxy" -}}
{{- .Values.config.trustProxy -}}
{{- end -}}

{{/*
An ingress means a proxy is in front, and an unset TRUST_PROXY there is not a
default — it is every caller sharing one rate-limit bucket, which reads as a
working install until someone is throttled by a stranger. The chart already
refuses a missing ingress.host and a missing databaseUrl for smaller reasons.

Only ingress.enabled is checked, because it is the only proxy the chart knows
about. Routing arranged outside it cannot be detected here, which is why the
value is reported at install rather than only validated.
*/}}
{{- define "indexterity.validateTrustProxy" -}}
{{- if and .Values.ingress.enabled (not .Values.config.trustProxy) -}}
{{- fail "config.trustProxy is required when ingress.enabled — every request then arrives from the ingress, and without it each per-IP rate limit collapses into one bucket shared by every caller. Set it to the pod network's CIDR, usually \"10.0.0.0/8\" (k3s 10.42.0.0/16, Calico 192.168.0.0/16, an EKS default VPC 172.31.0.0/16 — check yours rather than pasting). Prefer a range over \"true\": better-auth attributes a forwarded header only from ranges, and with \"true\" it resolves nothing once the ingress has appended itself, which leaves the auth limits shared." -}}
{{- end -}}
{{- end -}}
