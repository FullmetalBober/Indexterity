# syntax=docker/dockerfile:1
# Separate image so the api (and worker) deploy independently. Build context = repo root.
FROM docker.io/library/node:26-slim AS base
WORKDIR /app
RUN npm install -g turbo@2.10.5

# Prune the monorepo down to just what @repo/api needs.
FROM base AS pruner
COPY . .
RUN turbo prune @repo/api --docker

# Install deps (this layer caches on the lockfile), then build, then drop devDeps.
FROM base AS builder
COPY --from=pruner /app/out/json/ .
# The npm cache survives its own layer being invalidated: bump one dependency
# and BuildKit reruns this step, but it refetches only what actually changed
# instead of the whole tree. It is a BuildKit-local cache, so it speeds up
# rebuilds on a developer's machine and on a warm builder; CI's win comes from
# the layer cache above it, which is a different mechanism.
RUN --mount=type=cache,target=/root/.npm npm install
COPY --from=pruner /app/out/full/ .
RUN --mount=type=cache,target=/root/.cache/turbo turbo run build --filter=@repo/api
RUN npm prune --omit=dev

FROM docker.io/library/node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app .
EXPOSE 3001
# Worker deploys use the same image with: CMD ["node", "apps/api/dist/worker.js"]
CMD ["node", "apps/api/dist/main.js"]
