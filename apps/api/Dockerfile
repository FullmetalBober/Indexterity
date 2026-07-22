# syntax=docker/dockerfile:1
# Build context is the repo root (separate image so api deploys independently).
FROM docker.io/library/node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npx turbo run build --filter=@repo/api...

FROM docker.io/library/node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# TODO: slim with `turbo prune --docker`; copying the full tree for now.
COPY --from=build /app ./
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
