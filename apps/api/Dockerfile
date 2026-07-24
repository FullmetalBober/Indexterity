# syntax=docker/dockerfile:1
# Separate image so the api (and worker) deploy independently. Build context = repo root.
FROM docker.io/library/node:24-slim AS base
WORKDIR /app
RUN npm install -g turbo@2.10.5

# Prune the monorepo down to just what @repo/api needs.
FROM base AS pruner
COPY . .
RUN turbo prune @repo/api --docker

# Install deps (this layer caches on the lockfile), then build, then drop devDeps.
FROM base AS builder
COPY --from=pruner /app/out/json/ .
RUN npm install
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@repo/api
RUN npm prune --omit=dev

FROM docker.io/library/node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app .
EXPOSE 3001
# Worker deploys use the same image with: CMD ["node", "apps/api/dist/worker.js"]
CMD ["node", "apps/api/dist/main.js"]
