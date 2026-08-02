#!/usr/bin/env bash
# Deploy the Helm chart to a throwaway Kind cluster and prove it works.
#
# Not a substitute for the other suites — it answers a different question. The
# unit and integration tests run the code; this runs the CHART: hook ordering,
# secret wiring, Service DNS between web and api, and whether the images the
# Dockerfiles produce actually boot under a kubelet. Every bug it has found so
# far was invisible to `helm lint`, because rendering valid YAML and being
# installable are not the same thing.
#
# Requires: kind, kubectl, helm, podman (or docker).
# Usage:   deploy/kind-test.sh [--keep]
set -euo pipefail

# podman's network backend shells out to `nft` (nftables). Run this from inside
# a Node project and node_modules/.bin is on PATH — where @vercel/nft installs a
# binary of the same name. netavark then reads JavaScript where it expects
# nftables JSON and the cluster never starts:
#   Error: netavark: nftables error: got invalid json: EOF at line 1 column 0
# Nothing here needs those entries, so drop them rather than leave a trap for
# whoever runs this next.
_clean_path=""
IFS=: read -ra _path_parts <<< "$PATH"
for _part in "${_path_parts[@]}"; do
  case "$_part" in */node_modules/.bin) continue ;; esac
  _clean_path="${_clean_path:+$_clean_path:}$_part"
done
PATH="$_clean_path"
export PATH
unset _clean_path _path_parts _part

CLUSTER=${CLUSTER:-indexterity}
NS=${NS:-indexterity}
TAG=${TAG:-0.1.0}
KEEP=${1:-}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# podman locally, docker on a CI runner. kind needs telling which.
if [ -z "${CTR:-}" ]; then
  if command -v podman >/dev/null 2>&1; then CTR=podman; else CTR=docker; fi
fi
if [ "$CTR" = "podman" ]; then export KIND_EXPERIMENTAL_PROVIDER=podman; fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
# podman tags into localhost/; docker does not.
image_ref() {
  if [ "$CTR" = "podman" ]; then echo "localhost/indexterity/$1:$TAG"; else echo "indexterity/$1:$TAG"; fi
}

cleanup() {
  if [ "$KEEP" != "--keep" ]; then
    step "tearing down"
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  else
    echo "cluster kept: kubectl --context kind-$CLUSTER -n $NS get pods"
  fi
}
trap cleanup EXIT

step "creating kind cluster"
kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s
kubectl config use-context "kind-$CLUSTER" >/dev/null

step "building images"
"$CTR" build -f "$ROOT/apps/api/Dockerfile" -t "indexterity/api:$TAG" "$ROOT"
"$CTR" build -f "$ROOT/apps/web/Dockerfile" -t "indexterity/web:$TAG" "$ROOT"

step "loading images into the cluster"
for img in api web; do
  kind load docker-image "$(image_ref "$img")" --name "$CLUSTER"
done

step "postgres + mongo (the chart bundles neither, on purpose)"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -n "$NS" -f "$ROOT/deploy/kind-dependencies.yaml"
kubectl -n "$NS" wait --for=condition=available deploy/postgres deploy/mongo --timeout=180s

step "installing the chart"
# allowInsecureAuthUrl: a Kind cluster terminates no TLS, and the api refuses a
# non-https auth URL in production. trustProxy: kube-proxy hides the client
# address, so without it the per-IP rate limits share one bucket.
helm upgrade --install indexterity "$ROOT/deploy/helm/indexterity" -n "$NS" --wait --timeout 5m \
  --set "api.image.repository=$(image_ref api | sed "s/:$TAG//"),api.image.tag=$TAG,api.image.pullPolicy=Never,api.replicas=1" \
  --set "web.image.repository=$(image_ref web | sed "s/:$TAG//"),web.image.tag=$TAG,web.image.pullPolicy=Never,web.replicas=1" \
  --set "config.signupMode=open,config.allowPrivateClusterTargets=true" \
  --set "config.allowInsecureAuthUrl=true,config.trustProxy=true" \
  --set "secrets.databaseUrl=postgres://indexterity:indexterity@postgres:5432/indexterity" \
  --set "secrets.betterAuthSecret=kind-test-secret-not-for-real-use-0000" \
  --set "secrets.masterKey=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

step "helm test"
helm test indexterity -n "$NS" --timeout 3m

step "functional check: sign up and connect the in-cluster mongo"
# The chart's own test only curls two ports. This exercises what the chart is
# actually for: migrations applied, MASTER_KEY sealing a credential, and the api
# reaching a database over cluster DNS.
kubectl -n "$NS" run kind-check --rm -i --restart=Never --image=curlimages/curl:8.11.0 --quiet -- sh -c '
  set -e
  API=http://indexterity-api:3001
  ORIGIN=http://indexterity-web:3000
  COOKIE=$(curl -s -i -X POST "$API/api/auth/sign-up/email" -H "content-type: application/json" \
    -H "origin: $ORIGIN" -H "x-forwarded-for: 203.0.113.7" \
    -d "{\"email\":\"kind-check@example.test\",\"password\":\"Kind-Passw0rd!\",\"name\":\"Kind\"}" \
    | grep -i "^set-cookie:" | sed "s/^[Ss]et-[Cc]ookie: //" | cut -d";" -f1 | tr "\n" ";")
  [ -n "$COOKIE" ] || { echo "sign-up returned no session cookie"; exit 1; }
  echo "$COOKIE" | grep -q "__Secure-" || { echo "session cookie is not Secure"; exit 1; }
  echo "signed up, cookie is Secure"
  curl -sf -X POST "$API/clusters" -H "cookie: $COOKIE" -H "content-type: application/json" \
    -H "origin: $ORIGIN" -H "x-forwarded-for: 203.0.113.7" \
    -d "{\"name\":\"Kind Mongo\",\"connectionString\":\"mongodb://mongo:27017\"}" > /dev/null
  echo "connected a cluster over cluster DNS"
'

step "logs must be clean (house rule: no errors, no warnings)"
noisy=0
for c in api web worker; do
  n=$(kubectl -n "$NS" logs -l "app.kubernetes.io/component=$c" --tail=500 2>/dev/null \
      | grep -icE '"level":(40|50|60)|ERROR|WARN' || true)
  printf '  %-7s %s\n' "$c" "$n"
  [ "$n" = "0" ] || noisy=1
done
if [ "$noisy" != "0" ]; then
  echo "FAILED: a pod logged a warning or error"
  for c in api web worker; do
    kubectl -n "$NS" logs -l "app.kubernetes.io/component=$c" --tail=500 2>/dev/null | grep -iE 'ERROR|WARN' | head -5
  done
  exit 1
fi

step "all green"
