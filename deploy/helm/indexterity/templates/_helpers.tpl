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

{{/* In-cluster api base URL — what the web pods and better-auth default to. */}}
{{- define "indexterity.internalApiUrl" -}}
{{- printf "http://%s-api:%v" (include "indexterity.fullname" .) .Values.api.service.port -}}
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
- name: DEFAULT_ORG_PLAN
  value: {{ .Values.config.defaultOrgPlan | quote }}
- name: LOG_LEVEL
  value: {{ .Values.config.logLevel | quote }}
- name: ALLOW_PRIVATE_CLUSTER_TARGETS
  value: {{ .Values.config.allowPrivateClusterTargets | quote }}
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
TRUST_PROXY. Explicit value wins; otherwise an ingress in front means the
forwarded address is the real client and the rate limiters should use it.
*/}}
{{- define "indexterity.trustProxy" -}}
{{- if .Values.config.trustProxy -}}
{{- .Values.config.trustProxy -}}
{{- else -}}
{{- ternary "true" "false" .Values.ingress.enabled -}}
{{- end -}}
{{- end -}}
