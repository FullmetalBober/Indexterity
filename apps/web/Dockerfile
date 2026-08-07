# syntax=docker/dockerfile:1
# Separate image so web deploys independently. Build context = repo root.
FROM docker.io/library/node:26-slim AS base
WORKDIR /app
RUN npm install -g turbo@2.10.5

FROM base AS pruner
COPY . .
RUN turbo prune @repo/web --docker

FROM base AS builder
# Vite inlines VITE_* at build time — set per environment. VITE_WEB_ORIGIN is this
# app's own public origin (used as the Origin for auth requests to the api).
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL
ARG VITE_WEB_ORIGIN=http://localhost:3000
ENV VITE_WEB_ORIGIN=$VITE_WEB_ORIGIN
COPY --from=pruner /app/out/json/ .
# The npm cache survives its own layer being invalidated: bump one dependency
# and BuildKit reruns this step, but it refetches only what actually changed
# instead of the whole tree. It is a BuildKit-local cache, so it speeds up
# rebuilds on a developer's machine and on a warm builder; CI's win comes from
# the layer cache above it, which is a different mechanism.
RUN --mount=type=cache,target=/root/.npm npm install
COPY --from=pruner /app/out/full/ .
RUN --mount=type=cache,target=/root/.cache/turbo turbo run build --filter=@repo/web

FROM docker.io/library/node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The nitro build output is self-contained — no node_modules needed at runtime.
COPY --from=builder /app/apps/web/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
