# syntax=docker/dockerfile:1
# Separate image so the api deploys independently of the dashboard. Build context = repo root.
#
# alpine rather than slim, because the base IS the image: 252 MB of
# node:26-slim against 181 MB of node:26-alpine, for an api that ships as four
# bundled files and no node_modules (D73, D182). Worth 71 MB here and the same
# again in each of the other two images.
#
# It is a base swap and not a rebuild: with no node_modules there is no `.node`
# file in the image at all, so no native code to recompile for musl. (Before
# D182 that was a measurement rather than a consequence: `find node_modules
# -name "*.node"` returned zero, until Sentry 11 brought in a musl build of
# oxc-parser that nothing loaded.)
#
# The risk worth naming is musl's resolver, not the packages: this product dials
# customer clusters by hostname, and `mongodb+srv://` is an SRV lookup. See D76 for
# what was tested — three mongo majors' integration suites through a real
# `mongodb+srv://` string on musl, and the one behavioural difference found, which
# is in a resolver's error REPLY rather than in this image.
FROM docker.io/library/node:26-alpine AS base
WORKDIR /app
RUN npm install -g turbo@2.10.5

# Prune the monorepo down to just what @repo/api needs.
FROM base AS pruner
COPY . .
RUN turbo prune @repo/api --docker

# Install deps (this layer caches on the lockfile), then build.
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

# The bundles and the two things they read from disk, and nothing else (#580,
# D182). Every entrypoint is one esbuild bundle (apps/api/scripts/bundle.mts), so
# nothing here resolves a package: node_modules was 305 MB of a tree the bundles
# already contain. The four files are that script's ENTRYPOINTS, and one added
# there and not here is not in the image. package.json is what version.ts reads,
# and drizzle/ holds the SQL migrate.js applies.
#
# Same paths as the whole tree this used to copy, so the chart's migrate Job and
# every `node apps/api/dist/…` an operator runs find the file where it was.
FROM docker.io/library/node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/api/package.json apps/api/
COPY --from=builder /app/apps/api/drizzle apps/api/drizzle
COPY --from=builder /app/apps/api/dist/main.js /app/apps/api/dist/migrate.js \
     /app/apps/api/dist/rotate-key.js /app/apps/api/dist/set-plan.js apps/api/dist/
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
