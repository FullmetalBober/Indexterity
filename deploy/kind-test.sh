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
#          RELEASE=0.1.0 deploy/kind-test.sh   # the PUBLISHED artifacts instead
#          PREBUILT=1 deploy/kind-test.sh      # images already in the engine
#          TOPOLOGY=single-container deploy/kind-test.sh
#
# TOPOLOGY runs the same assertions against a different packaging (see `topology`
# in values.yaml), because that is where they earn the most: the checks below
# reach the api and the dashboard through their Services and know nothing about
# how many pods or containers are behind them, so running them per topology is
# what proves the claim that nothing in front of the chart has to care.
#   split             three Deployments, two images (the default)
#   single-pod        one pod, an api and a web container, plus the worker's own
#   single-container  one pod, ONE container from the all-in-one image, with the
#                     job runner embedded — the whole release in one container
#
# RELEASE mode answers a question the default cannot: does what we shipped
# work? The default builds from the working tree, so it passes even if the
# release workflow published something broken — a chart whose appVersion names
# an image tag that was never pushed, or a package left private, both of which
# a green workflow reports as success. In RELEASE mode nothing is built and
# nothing is loaded: the chart and both images come from ghcr.io exactly as a
# stranger would fetch them, so registry visibility is part of the test.
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
# In RELEASE mode the version under test IS the tag, so the two cannot drift.
RELEASE=${RELEASE:-}
TAG=${TAG:-${RELEASE:-0.1.0}}
TOPOLOGY=${TOPOLOGY:-split}
case "$TOPOLOGY" in
  split | single-pod) IMAGES="api web" ;;
  # One image, and that is the point of the topology: the migration Job and the
  # worker run their own entrypoints out of it too, so nothing here pulls the
  # other two.
  single-container) IMAGES="all-in-one" ;;
  *) echo "TOPOLOGY must be split, single-pod or single-container (got $TOPOLOGY)"; exit 1 ;;
esac
GHCR_OWNER=${GHCR_OWNER:-fullmetalbober}
# Pinned so the preload and the manifests can never disagree about a tag.
PG_IMAGE=${PG_IMAGE:-docker.io/library/postgres:18-alpine}
MONGO_IMAGE=${MONGO_IMAGE:-docker.io/library/mongo:8}
CURL_IMAGE=${CURL_IMAGE:-docker.io/curlimages/curl:8.11.0}
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
# Which Dockerfile builds each name in IMAGES. The api's and the web's sit with
# the app they build; the all-in-one's builds both, so it sits with the deployment.
dockerfile_for() {
  case "$1" in
    all-in-one) echo "$ROOT/deploy/all-in-one/Dockerfile" ;;
    *) echo "$ROOT/apps/$1/Dockerfile" ;;
  esac
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
# Asking the container engine, not `kind get clusters`: kind 0.32 lists clusters
# with --format '{{index .Labels "..."}}', and podman 6 no longer exposes
# .Labels as a map to templates, so listing fails with "cannot index
# slice/array with type string". create/delete/load are unaffected. Suppressing
# that error and reading it as "no such cluster" would make --keep followed by a
# re-run try to create one that already exists.
if [ -z "$($CTR ps -a --filter "label=io.x-k8s.kind.cluster=$CLUSTER" -q 2>/dev/null)" ]; then
  kind create cluster --name "$CLUSTER" --wait 120s
else
  echo "reusing existing cluster $CLUSTER"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

if [ -n "$RELEASE" ]; then
  # Pulled on the host and loaded, like every other image here, so the kubelet
  # never depends on DNS through the container network. It also proves the
  # packages are public: an anonymous pull is what a stranger gets.
  step "pulling the published images ($RELEASE)"
  for img in $IMAGES; do
    $CTR pull "ghcr.io/$GHCR_OWNER/indexterity-$img:$RELEASE"
    kind load docker-image "ghcr.io/$GHCR_OWNER/indexterity-$img:$RELEASE" --name "$CLUSTER"
  done
else
  # PREBUILT: the caller already built and tagged them, and knows how to do it
  # faster than a bare `build` can — CI uses buildx against a layer cache. The
  # tags are the contract; where they came from is not this script's business.
  if [ -z "${PREBUILT:-}" ]; then
    step "building images"
    for img in $IMAGES; do
      "$CTR" build -f "$(dockerfile_for "$img")" -t "indexterity/$img:$TAG" "$ROOT"
    done
  else
    step "using prebuilt images"
    for img in $IMAGES; do
      $CTR image inspect "$(image_ref "$img")" >/dev/null 2>&1 ||
        { echo "PREBUILT is set but $(image_ref "$img") is not in $CTR"; exit 1; }
    done
  fi

  step "loading images into the cluster"
  for img in $IMAGES; do
    kind load docker-image "$(image_ref "$img")" --name "$CLUSTER"
  done
fi

# The dependencies too, rather than letting the kubelet pull them. A kind node
# resolves DNS through the container network, which is one more moving part
# than this test should depend on — a flaky resolver there fails as
# ImagePullBackOff and looks like a chart problem. Pulling on the host and
# loading is also faster on a re-run, since the host cache is warm.
step "preloading dependency images"
for img in "$PG_IMAGE" "$MONGO_IMAGE" "$CURL_IMAGE"; do
  $CTR image exists "$img" 2>/dev/null || $CTR pull "$img"
  kind load docker-image "$img" --name "$CLUSTER"
done

step "postgres + mongo (the chart bundles neither, on purpose)"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -n "$NS" -f "$ROOT/deploy/kind-dependencies.yaml"
kubectl -n "$NS" wait --for=condition=available deploy/postgres deploy/mongo --timeout=180s

step "installing the chart (topology: $TOPOLOGY)"
if [ -n "$RELEASE" ]; then
  CHART="oci://ghcr.io/$GHCR_OWNER/charts/indexterity"
  CHART_ARGS="--version $RELEASE"
  repo_for() { echo "ghcr.io/$GHCR_OWNER/indexterity-$1"; }
else
  CHART="$ROOT/deploy/helm/indexterity"
  CHART_ARGS=""
  repo_for() { image_ref "$1" | sed "s/:$TAG//"; }
fi

# The image the topology actually pulls, and — for the merged ones — the worker
# shape that goes with it. single-container embeds the job runner (RUN_WORKER),
# which is the appliance the image exists for and the only place that code path
# is exercised under a kubelet; single-pod keeps the worker's own Deployment, so
# between them the matrix covers both.
case "$TOPOLOGY" in
  single-container)
    IMAGE_ARGS="allInOne.image.repository=$(repo_for all-in-one),allInOne.image.tag=$TAG,allInOne.image.pullPolicy=Never"
    WORKER_ARGS="worker.enabled=false,api.runWorker=true"
    COMPONENTS="app"
    ;;
  single-pod)
    IMAGE_ARGS="api.image.repository=$(repo_for api),api.image.tag=$TAG,api.image.pullPolicy=Never,web.image.repository=$(repo_for web),web.image.tag=$TAG,web.image.pullPolicy=Never"
    WORKER_ARGS="worker.enabled=true"
    COMPONENTS="app worker"
    ;;
  *)
    IMAGE_ARGS="api.image.repository=$(repo_for api),api.image.tag=$TAG,api.image.pullPolicy=Never,web.image.repository=$(repo_for web),web.image.tag=$TAG,web.image.pullPolicy=Never"
    WORKER_ARGS="worker.enabled=true"
    COMPONENTS="api web worker"
    ;;
esac
# allowInsecureAuthUrl: a Kind cluster terminates no TLS, and the api refuses a
# non-https auth URL in production. trustProxy: kube-proxy hides the client
# address, so without it the per-IP rate limits share one bucket. metrics: off by
# default since the exporter costs memory in every process, and set here on
# purpose — the chart's own test asserts the endpoints, so leaving it at the
# default would quietly retire those assertions.
# Never: every image is already in the node, and a pull would only be a slower
# way to fetch what is there — or a spurious failure if the registry blinks.
# shellcheck disable=SC2086  # CHART_ARGS is a deliberate word split
helm upgrade --install indexterity "$CHART" $CHART_ARGS -n "$NS" --wait --timeout 5m \
  --set "topology=$TOPOLOGY,api.replicas=1,web.replicas=1" \
  --set "metrics.enabled=true" \
  --set "$IMAGE_ARGS" \
  --set "$WORKER_ARGS" \
  --set "config.signupMode=open,config.allowPrivateClusterTargets=true" \
  --set "config.allowInsecureClusterTls=true" \
  --set "config.allowInsecureAuthUrl=true,config.trustProxy=true" \
  --set "secrets.databaseUrl=postgres://indexterity:indexterity@postgres:5432/indexterity" \
  --set "secrets.betterAuthSecret=kind-test-secret-not-for-real-use-0000" \
  --set "secrets.masterKey=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

step "the topology installed is the one that was asked for"
# Without this the whole run would pass on a chart that quietly ignored
# `topology` and installed the default — every assertion below reaches the api
# and the dashboard through their Services, which is exactly the property that
# makes them blind to what is behind them.
case "$TOPOLOGY" in
  split) SERVING=indexterity-api; WANT_CONTAINERS="api" ;;
  single-pod) SERVING=indexterity; WANT_CONTAINERS="api web" ;;
  single-container) SERVING=indexterity; WANT_CONTAINERS="app" ;;
esac
GOT_CONTAINERS=$(kubectl -n "$NS" get deploy "$SERVING" -o jsonpath='{.spec.template.spec.containers[*].name}')
if [ "$GOT_CONTAINERS" != "$WANT_CONTAINERS" ]; then
  echo "deploy/$SERVING has containers [$GOT_CONTAINERS], expected [$WANT_CONTAINERS]"
  kubectl -n "$NS" get deploy
  exit 1
fi
printf '  deploy/%s: %s\n' "$SERVING" "$GOT_CONTAINERS"
# Both Services have to have endpoints whatever is behind them — merged, that is
# one pod answering two Services, which is the seam that keeps the ingress and
# every in-cluster caller ignorant of the topology.
# EndpointSlices rather than `get endpoints`: the v1 Endpoints API is deprecated
# from 1.33 and reading it prints a warning on every run, which is the sort of
# noise the log check below exists to keep out.
for svc in indexterity-api indexterity-web; do
  # READY endpoints only. An EndpointSlice lists a not-yet-ready address too, with
  # conditions.ready=false — so the unfiltered form reported an endpoint for a pod
  # that was still booting and called it proof.
  addrs=$(kubectl -n "$NS" get endpointslices -l "kubernetes.io/service-name=$svc" \
    -o jsonpath='{.items[*].endpoints[?(@.conditions.ready==true)].addresses[*]}')
  [ -n "$addrs" ] || { echo "svc/$svc has no ready endpoints"; exit 1; }
  printf '  svc/%s -> %s\n' "$svc" "$addrs"
done

step "helm test"
# The probe pod echoes after each assertion it passes, so its log names the one
# that failed — and `helm test` prints none of it. Without this a failure reads
# only "pod indexterity-test-dashboard failed", which is every assertion at once.
if ! helm test indexterity -n "$NS" --timeout 3m; then
  echo "--- test pod log (the last line it echoed is the last assertion that PASSED) ---"
  # The pod survives a failure: its delete policy only removes it on success.
  kubectl -n "$NS" logs -l app.kubernetes.io/component=test --tail=-1 || true
  # And what the assertion was talking TO. Without this a CI failure says only
  # which curl failed, which is the question rather than the answer: a refused
  # connection to a Service with endpoints means the pod behind it restarted, or
  # never bound that port, and only the pod can say which. RESTARTS is the column
  # that matters — a container the supervisor took down and the kubelet brought
  # back is indistinguishable from a slow boot until you look at the count.
  echo "--- pods (RESTARTS is the interesting column) ---"
  kubectl -n "$NS" get pods -o wide || true
  for c in $COMPONENTS; do
    echo "--- describe: $c (look for OOMKilled, Last State, probe failures) ---"
    kubectl -n "$NS" describe pod -l "app.kubernetes.io/component=$c" | sed -n '/Containers:/,/Events:/p' || true
    echo "--- logs: $c (current) ---"
    kubectl -n "$NS" logs -l "app.kubernetes.io/component=$c" --all-containers --tail=80 || true
    # The log of the instance that DIED, which the current one has replaced and
    # which is the only place a crash reason is written.
    echo "--- logs: $c (previous instance, if it restarted) ---"
    kubectl -n "$NS" logs -l "app.kubernetes.io/component=$c" --all-containers --previous --tail=80 2>/dev/null || echo "  (no previous instance — it did not restart)"
  done
  exit 1
fi

step "functional check: sign up, make an org, connect the in-cluster mongo"
# The chart's own test only curls two ports. This exercises what the chart is
# actually for: migrations applied, MASTER_KEY sealing a credential, and the api
# reaching a database over cluster DNS.
kubectl -n "$NS" run kind-check --rm -i --restart=Never --image="$CURL_IMAGE" --quiet -- sh -c '
  set -e
  API=http://indexterity-api:3001
  ORIGIN=http://indexterity-web:3000
  SET_COOKIE=$(curl -s -i -X POST "$API/api/auth/sign-up/email" -H "content-type: application/json" \
    -H "origin: $ORIGIN" -H "x-forwarded-for: 203.0.113.7" \
    -d "{\"email\":\"kind-check@example.test\",\"password\":\"Kind-Passw0rd!\",\"name\":\"Kind\"}" \
    | grep -i "^set-cookie:" | sed "s/^[Ss]et-[Cc]ookie: //")
  [ -n "$SET_COOKIE" ] || { echo "sign-up returned no session cookie"; exit 1; }
  echo "$SET_COOKIE" | grep -q "__Secure-" || { echo "session cookie is not Secure"; exit 1; }
  # The session TOKEN alone, deliberately not the session_data cache cookie
  # beside it. Creating an org below changes the session row without re-signing
  # that cache, so the api expires it in the response — which a browser honours
  # and a shell holding a captured string does not. Replaying the stale copy
  # would keep answering "belongs to no org" for the length of the cache and
  # fail the next step. See the hooks.after note in auth/auth.config.ts.
  COOKIE=$(echo "$SET_COOKIE" | grep -o "__Secure-better-auth\.session_token=[^;]*" | head -n1)
  [ -n "$COOKIE" ] || { echo "no session_token cookie in the sign-up response"; exit 1; }
  echo "signed up, cookie is Secure"
  # A fresh account belongs to nowhere. The api stopped conjuring "My Org"
  # behind the first authenticated request when tenancy moved onto the
  # organization plugin, so a cluster has nothing to hang off until one is made
  # on purpose — the same first step the dashboard asks of a new reader.
  curl -sf -X POST "$API/api/auth/organization/create" -H "cookie: $COOKIE" \
    -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-forwarded-for: 203.0.113.7" \
    -d "{\"name\":\"Kind Check\",\"slug\":\"kind-check\"}" > /dev/null
  echo "made an organization"
  curl -sf -X POST "$API/api/clusters" -H "cookie: $COOKIE" -H "content-type: application/json" \
    -H "origin: $ORIGIN" -H "x-forwarded-for: 203.0.113.7" \
    -d "{\"name\":\"Kind Mongo\",\"connectionString\":\"mongodb://mongo:27017\"}" > /dev/null
  echo "connected a cluster over cluster DNS"
'

step "logs must be clean (house rule: no errors, no warnings)"
# Per COMPONENT rather than per workload, because merged they are the same pod:
# `app` covers the api and the dashboard together, and in single-container that
# is one container whose log holds both processes' output plus the supervisor's.
noisy=0
for c in $COMPONENTS; do
  # --all-containers, because `app` is two of them in single-pod and kubectl
  # otherwise refuses a selector that matches a multi-container pod.
  n=$(kubectl -n "$NS" logs -l "app.kubernetes.io/component=$c" --all-containers --tail=500 2>/dev/null \
      | grep -icE '"level":(40|50|60)|ERROR|WARN' || true)
  printf '  %-7s %s\n' "$c" "$n"
  [ "$n" = "0" ] || noisy=1
done
if [ "$noisy" != "0" ]; then
  echo "FAILED: a pod logged a warning or error"
  for c in $COMPONENTS; do
    kubectl -n "$NS" logs -l "app.kubernetes.io/component=$c" --all-containers --tail=500 2>/dev/null | grep -iE 'ERROR|WARN' | head -5
  done
  exit 1
fi

step "all green"
