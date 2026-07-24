# syntax=docker/dockerfile:1
# Deployed inside the customer's network; talks out to the control plane only.
FROM docker.io/library/node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npx turbo run build --filter=@repo/agent...

FROM docker.io/library/node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
CMD ["node", "apps/agent/dist/main.js"]
