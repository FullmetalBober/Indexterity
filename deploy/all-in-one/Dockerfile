# syntax=docker/dockerfile:1
# The all-in-one image: the api, the dashboard and the job runner in ONE
# container, under the supervisor beside this file. Build context = repo root.
#
# It exists for hosts that run a single container per service and have no concept
# of a pod — Fly, Render, Cloud Run, Compose, `docker run` — and for the Helm
# chart's `topology: single-container`. The two separate images remain the default
# everywhere else: this one trades independent rollouts for there being one thing
# to deploy, which is a good trade for a self-hosted install and a bad one for a
# fleet.
#
# Nothing about the CODE differs. Both builds are the same turbo tasks producing
# the same artefacts as apps/api/Dockerfile and apps/web/Dockerfile; only the
# packaging is different, so a bug here cannot be a bug the split images do not
# have.
#
# alpine, same base and same reasoning as the two images above (D76). 558 MB → 487.
#
# Measuring that turned up something this file should say out loud: its
# node_modules is 338 MB where the api image's is 153 MB, for the same api. The
# difference is the DASHBOARD's production dependency tree — `@tanstack/react-start`
# is a dependency of @repo/web and correctly so, but in a runtime that starts the
# dashboard from apps/web/.output it is build-time, and the strip below only removes
# devDependencies. Two prebuilt lightningcss bindings (gnu and musl, 9.6 MB each,
# one of which can never load) arrive that way. Present on slim too, so the base
# swap neither caused nor cured it. #182.
FROM docker.io/library/node:26-alpine AS base
WORKDIR /app
RUN npm install -g turbo@2.10.5

# One prune for both packages rather than two trees: they share @repo/contracts,
# @repo/errors and @repo/metrics, and pruning them separately would install and
# build those three twice in one image.
FROM base AS pruner
COPY . .
RUN turbo prune @repo/api @repo/web --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
# Same BuildKit npm cache as the other two images, and for the same reason: a
# dependency bump reruns this step but refetches only what changed.
RUN --mount=type=cache,target=/root/.npm npm install
COPY --from=pruner /app/out/full/ .
RUN --mount=type=cache,target=/root/.cache/turbo turbo run build --filter=@repo/api --filter=@repo/web
# After both builds, never between them: the dashboard's build needs vite and
# tailwind, which are devDependencies. The api's runtime needs node_modules and
# the nitro output needs none, so what survives here is exactly the api's tree
# plus apps/web/.output.
#
# Reinstalled from stripped manifests rather than pruned, for the reason the api's
# Dockerfile gives at length: `turbo prune` regenerates a lockfile with no dev
# markers, so `npm prune --omit=dev` reads the whole graph as production and keeps
# typescript, drizzle-kit, @rolldown and esbuild. This image carries both apps, so
# it was paying that once for a tree only the api reads at runtime.
COPY deploy/prod-manifests.mts /tmp/prod-manifests.mts
RUN --mount=type=cache,target=/root/.npm \
    node /tmp/prod-manifests.mts . && rm -rf node_modules && npm install --omit=dev

FROM docker.io/library/node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The whole pruned tree, which already contains apps/web/.output where the builder
# left it — so the dashboard runs from the same relative path as in its own image
# (cwd /app/apps/web, entry .output/server/index.mjs) rather than a layout that
# only exists here.
COPY --from=builder /app .
# Copied, not built: node strips the types when it loads it, so what runs in the
# container is the file in the repository. The pruned root package.json that came
# with the tree above is `"type": "module"`, which is what makes this an ES module
# — apps/api keeps its own `"type": "commonjs"`, so the api's dist is unaffected.
COPY deploy/all-in-one/supervisor.ts ./supervisor.ts
# The job runner too, because a single-container deployment has nowhere else to
# put it: without this the schedule never runs and nothing is ever collected. The
# Helm chart overrides it from api.runWorker, and any host can with RUN_WORKER=false.
ENV RUN_WORKER=true
# api, dashboard. The two metrics listeners are 9464 and 9465 when
# METRICS_ENABLED=true; deliberately not published here, since the endpoint has no
# auth and exposing it is a decision.
EXPOSE 3000 3001
CMD ["node", "supervisor.ts"]
