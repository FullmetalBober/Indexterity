# syntax=docker/dockerfile:1
# Build context is the repo root (separate image so web deploys independently).
FROM docker.io/library/node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npx turbo run build --filter=@repo/web...

FROM docker.io/library/node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# TODO: slim with `turbo prune --docker`; copying the full tree for now.
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "apps/web/.output/server/index.mjs"]
