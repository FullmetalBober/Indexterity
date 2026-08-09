# syntax=docker/dockerfile:1
# Separate image so web deploys independently. Build context = repo root.
FROM docker.io/library/node:26-slim AS base
WORKDIR /app
RUN npm install -g turbo@2.10.5

FROM base AS pruner
COPY . .
RUN turbo prune @repo/web --docker

FROM base AS builder
# No VITE_* build args. There were two, and nothing has read them since the
# browser stopped needing an api address of its own (#2): it calls /api on the
# origin that served the page. Every value this image reads is read at RUNTIME
# and validated then (apps/web/src/lib/env.ts), which is what lets one image
# deploy to every environment.
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
