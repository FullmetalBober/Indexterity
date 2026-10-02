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
# alpine, same base and same reasoning as the two images above (D76).
#
# No node_modules (D182): what ships is the api image's bundles, the dashboard's
# self-contained `.output`, the tunnel binary and the supervisor. It used to be the
# api's whole production tree as well — and before #182 the dashboard's too, which
# nothing here resolves from either (D77).
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

# The tunnel binary (apps/tunnel, D111): wireguard-go and gvisor's netstack,
# spawned per peering by the api.
#
# Its own stage, from the FULL context rather than from the pruned tree, because
# `turbo prune @repo/api` cannot see it: the api spawns the binary rather than
# importing it, so there is no package dependency to prune along. CGO off, so
# what lands in an alpine runtime is a static binary with nothing to link
# against — the same reason the api's bundles holding no native code is what
# makes the musl base safe.
FROM docker.io/library/golang:1.27.0-alpine AS tunnel
WORKDIR /src
COPY apps/tunnel/go.mod apps/tunnel/go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod go mod download
COPY apps/tunnel/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 go build -trimpath -o /out/indexterity-tunnel .

FROM docker.io/library/node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# What the api image ships, at the same paths and for the reasons its Dockerfile
# gives: the bundles, package.json for version.ts, drizzle/ for the migrator.
COPY --from=builder /app/apps/api/package.json apps/api/
COPY --from=builder /app/apps/api/drizzle apps/api/drizzle
COPY --from=builder /app/apps/api/dist/main.js /app/apps/api/dist/migrate.js \
     /app/apps/api/dist/rotate-key.js /app/apps/api/dist/set-plan.js apps/api/dist/
# Where the builder left it, so the dashboard runs from the same relative path as
# in its own image (cwd /app/apps/web, entry .output/server/index.mjs) rather than
# a layout that only exists here. Self-contained: nitro traces what the server
# imports into .output/server/node_modules, which is why apps/web/Dockerfile ships
# `.output` and nothing else. The dashboard's two package.json imports are
# build-time — vite inlines the version.
COPY --from=builder /app/apps/web/.output apps/web/.output
COPY --from=tunnel /out/indexterity-tunnel apps/tunnel/dist/indexterity-tunnel
# Copied, not built: node strips the types when it loads it, so what runs in the
# container is the file in the repository. The root package.json is there for
# one field: `"type": "module"` is what makes this an ES module. apps/api keeps
# its own `"type": "commonjs"`, so the api's bundles are unaffected.
COPY --from=builder /app/package.json ./package.json
COPY deploy/all-in-one/supervisor.ts ./supervisor.ts
# api, dashboard. The two metrics listeners are 9464 and 9465 when
# METRICS_ENABLED=true; deliberately not published here, since the endpoint has no
# auth and exposing it is a decision.
EXPOSE 3000 3001
CMD ["node", "supervisor.ts"]
