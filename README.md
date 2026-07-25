# mongo-optimizer

SaaS that continuously watches MongoDB indexes and manages them safely — drop
unused/redundant, merge overlapping, extend prefixes, create missing — and proves
the result in hard numbers. Read-only by default; the one irreversible step (a
drop) is gated behind an observe window, a double pre-flight, and a read-latency
regression check. Full design and decision log in
[`docs/architecture.md`](./docs/architecture.md).

## What it does

1. **Connect** a cluster — the connection string is sealed with envelope
   encryption; `demoMode` (read-only) is on by default.
2. **Collect** index usage and sizes on a schedule via `$indexStats` /
   `$collStats` — it never reads your documents.
3. **Decide** what to change with a pure analysis engine (see below).
4. **Approve** on the dashboard, or let policy auto-apply.
5. **Apply** safely: `hide → observe → drop` for removals, `build` for additions.
6. **Prove ROI**: freed bytes, index-count delta, and a per-collection
   read/write **latency trend** (before/after), with a regression gate that
   aborts — and remembers — anything that slowed reads down.

## How it decides

Two independent engines, both **pure functions in `packages/core`** — no I/O, so
they are deterministic and unit-testable without a database or a cluster.

### Removing indexes (usage + redundancy)

Runs off collected snapshots. First each index gets a **usage class** from its
op-count history:

- needs **≥ 3 snapshots**, otherwise treated as `FLAT_ZERO`
- ops are summed **across all replica-set members** per snapshot
- no snapshot has ops → `FLAT_ZERO`
- every snapshot has ops → `CONTINUOUS`
- some do, and the last 3 have ops → `PERIODIC_ALIVE`
- some do, but the last 3 are silent → `PERIODIC_DEAD` (e.g. a monthly job that
  got decommissioned)

Then the recommendation:

- `FLAT_ZERO` or `PERIODIC_DEAD` → **DROP_UNUSED**
- a proper key-prefix of another index (matching directions, compatible options)
  → **DROP_REDUNDANT**
- estimated bytes saved = the index's latest on-disk size

**Never dropped**, regardless of usage: `_id_`, unique, TTL, shard-key, partial,
sparse. Zero ops does not mean unused for these.

### Adding indexes (workload analysis, opt-in)

Requires `policy.workloadAnalysis`. Reads the profiler (`system.profile`), never
documents. Only collections with **≥ 1000 docs** are considered; **≥ 10 000 docs**
is "critical". For each recurring query shape that did a `COLLSCAN`:

- an existing index already equals the wanted fields → nothing
- an existing index is a proper prefix of the wanted fields → **UPDATE** (extend it)
- two or more single-field indexes cover the fields → **MERGE** into one compound
- otherwise → **CREATE**

### Instant apply

A `CREATE` on a critical collection, when `policy.instantCreate` is on and the
cluster is not in demo mode, is auto-approved and built immediately — adding an
index is safe and reversible, so a critical missing index does not wait for the
next scheduler tick. **Drops are never instant.**

## The apply pipeline (state machine)

`PROPOSED → APPROVED` (dashboard, or auto), then it depends on the type.

**Removals** (`DROP_UNUSED` / `DROP_REDUNDANT` / `MERGE` retire):

```
APPROVED → pre-flight → hide (collMod hidden:true) → HIDDEN → observe → finalize → DROPPED
```

- Hiding is instant and reversible, and starts the observe window
  (`policy.observeWindowDays`, default **30**).
- At hide time the collection's **baseline read latency** is recorded.
- `finalize` runs only after the window elapses and gates the drop three ways:
  1. **Regression** — if average read latency since hiding exceeds
     `baseline × 1.5` (minimum 20 reads), un-hide the index and park it in a
     **cooldown** (escalating on each repeat) so the engine won't re-propose and
     re-cycle it — that's the regression memory.
  2. **Pre-flight** — index now protected / covering index gone / index has fresh
     ops → un-hide and re-propose.
  3. Index already gone → mark `DROPPED`.
- Only when all gates pass does it drop — the single irreversible step. Freed
  bytes are written to `roi_metrics`.

**Additions** (`CREATE` / `UPDATE`): `APPROVED → build → ACTIVE`.

Every executed operation writes an **immutable `actions` row** (actor, result,
rollback token). In **demo mode** (default on) the pipeline computes everything
but never writes to your cluster.

## Policy knobs (per cluster)

| knob | effect | default |
|------|--------|---------|
| `demoMode` | read-only; compute but never write | on |
| `autoApply` | approve recommendations without a human | off |
| `workloadAnalysis` | enable the create/merge/update engine (needs profiler) | off |
| `instantCreate` | auto-build critical missing indexes | off |
| `observeWindowDays` | how long a hidden index bakes before drop | 30 |
| `maxCollectionSizeBytes` | size ceiling for touching a collection | — |

## Sharding & replication

- **Replica sets.** `$indexStats` is per-member; usage sums every member, so an
  index used only on a secondary still counts as used. The driver handles
  topology and read preference from the connection string.
- **Sharded clusters.** Point the app at the `mongos`. Usage (`$indexStats`),
  index sizes and read/write latency (`$collStats`) are aggregated across every
  shard, and each collection's shard key is read from `config.collections` so
  any index the shard key prefixes is treated as protected and never dropped.
  (If the connection's role can't read `config`, the collection is treated as
  unsharded — grant config read to enable shard-key protection.)

## Stack

Turbo monorepo · NestJS + Fastify (api) · TanStack Start + shadcn (web) ·
better-auth · Drizzle + PostgreSQL · ts-rest contracts · graphile-worker ·
Biome · strict TypeScript (no `any`, no `as`, no lint-ignore).

## Layout

The backend lives entirely in the NestJS app as feature modules (Nest
convention); the only shared packages are the api↔web contract and the tsconfig.

```
apps/api                control plane — NestJS + Fastify
  src/analysis          pure analysis + safety engine (classify, redundancy, workload, regression, safety)
  src/mongo             MongoDB collector + executor (index-only I/O)
  src/db                Drizzle schema + client + secret sealing
  src/auth              better-auth config
  src/jobs              graphile-worker tasks (collect/classify/suggest/apply/finalize)
  src/recommendations   ts-rest handlers · src/health health check
apps/web                dashboard — TanStack Start + shadcn

packages/contracts      ts-rest + zod contracts shared by api and web (the one shared type boundary)
packages/config         shared tsconfig
```

Notes on the shape:

- **`src/analysis` is pure** — no I/O, no Mongo, no DB, just functions over plain
  data. It is the decision engine and is unit-testable without any
  infrastructure. `src/mongo` parses driver output with zod at its boundary, so
  nothing downstream sees `any`.
- **`contracts` stays a package** because `web` imports it too — one source of
  truth for request/response types, no duplication or drift. Folding it into the
  api would force the Vite/TanStack build to reach into the Nest app's source.
- `turbo prune` ships each app only its slice of the graph (api pulls in
  `contracts` + `config`), which is what keeps the Docker images small.

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

## Deploy

Slim, independently-deployable images built with `turbo prune`:

```bash
docker build -f apps/api/Dockerfile -t mo-api .
docker build -f apps/web/Dockerfile -t mo-web \
  --build-arg VITE_API_URL=https://api.example.com .
```

api ≈ 390 MB, web ≈ 235 MB. The web bundle **bakes `VITE_API_URL` at build time**
(Vite inlines `VITE_*`), so set it per environment. The worker deploys from the
api image with `CMD ["node", "apps/api/dist/worker.js"]`.

## Notes

- The repo uses **npm workspaces**.
- **zod is pinned to v3** — `@ts-rest/*` peers require `^3.22.3`. Revisit when
  ts-rest ships zod 4 support.
- **Docker** resolves to **podman** + `podman-compose` on this machine; the
  compose file is standard and works with either.
</content>
</invoke>
