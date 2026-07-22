# mongo-optimizer

SaaS that continuously monitors MongoDB indexes and safely manages them — drop
unused/redundant, merge overlapping, create missing — proving the improvement in
hard numbers. See [`docs/architecture.md`](./docs/architecture.md) for the full
design and decision log.

## Stack

Turbo monorepo · NestJS + Fastify (api) · TanStack Start + shadcn (web) ·
better-auth · Drizzle + PostgreSQL · ts-rest contracts · graphile-worker ·
Biome · strict TypeScript (no `any`, no `as`, no lint-ignore).

## Layout

```
apps/api      control plane (NestJS + Fastify)
apps/web      dashboard (TanStack Start)
packages/core         pure analysis + safety engine
packages/mongo        MongoDB collector + executor (index-only)
packages/db           Drizzle schema + client + secret sealing
packages/contracts    ts-rest contracts + zod schemas (shared types)
packages/auth         better-auth config
packages/config       shared tsconfig
```

## Develop

```bash
cp .env.example .env      # then fill secrets
npm install
docker compose up         # postgres + api + web, hot reload
# or run locally:
npm run dev
```

Other: `npm run build` · `npm run typecheck` · `npm run lint`.
Database: `npm run db:generate` · `npm run db:migrate`.

## Notes

- Node ships via the local toolchain; the repo uses **npm workspaces** (pnpm can
  be swapped in later).
- **zod is pinned to v3** — `@ts-rest/*` peers require `^3.22.3`. Revisit when
  ts-rest ships zod 4 support.
- Docker here resolves to **podman** + `podman-compose` on this machine; the
  compose file is standard and works with either.
