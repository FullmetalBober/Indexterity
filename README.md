# Indexterity

**Indexterity** — index dexterity for MongoDB. A SaaS that continuously watches MongoDB indexes and manages them safely — drop
unused/redundant, merge overlapping, extend prefixes, create missing — and proves
the result in hard numbers. Read-only by default; the one irreversible step (a
drop) is gated behind an observe window, a double pre-flight, and a read-latency
regression check. Full design and decision log in
[`docs/architecture.md`](./docs/architecture.md).

## What it does

1. **Connect** a cluster — the connection string is sealed with envelope
   encryption; clusters start in **read-only mode** — the engine analyzes but never writes until an owner flips it live (dashboard toggle).
2. **Collect** index usage, sizes and per-collection read/write latency on a
   schedule via `$indexStats` / `$collStats` — it never reads your documents.
   Connections are pooled per cluster (one client reused across jobs).
3. **Decide** what to change with a pure analysis engine (see below).
4. **Approve** on the dashboard, or let policy auto-apply.
5. **Apply** safely: `hide → observe → drop` for removals, `build` for additions.
6. **Prove ROI**: freed bytes (and the **$/month** they cost, at
   `STORAGE_USD_PER_GB_MONTH`), index-count delta, and a per-collection
   read/write **latency trend** (before/after), with a regression gate that
   aborts — and remembers — anything that slowed reads down.
7. **One dashboard**: recommendations with approve/undo, read/write latency
   charts, the immutable activity trail, the policy editor, team & invites, and
   a cluster picker with the read-only ⇄ live toggle.

## How it decides

Two independent engines, both **pure functions in `apps/api/src/analysis`** — no
I/O, so they are deterministic and unit-tested without a database or a cluster.

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

Requires `policy.workloadAnalysis`. Query shapes come from **`$queryStats`**
(mongo 7+, no profiler needed — set `internalQueryStatsRateLimit > 0`), falling
back to the profiler (`system.profile`) when unavailable; documents are never
read either way. Only collections with **≥ 1000 docs** are considered;
**≥ 10 000 docs** is "critical". For each recurring query shape that did a
`COLLSCAN`:

- an existing index already equals the wanted fields → nothing
- an existing index is a proper prefix of the wanted fields → **UPDATE** (extend it)
- two or more single-field indexes cover the fields → **MERGE** into one compound
- otherwise → **CREATE**

### Instant apply

A `CREATE` on a critical collection, when `policy.instantCreate` is on and the
cluster is live (not read-only), is auto-approved and built immediately — adding an
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

**Additions** (`CREATE` / `UPDATE`): `APPROVED → build → ACTIVE`, then a
**post-build write watch**: the collection's write latency is baselined at build
time, and if writes regress past `baseline × 1.5` during the observe window the
new index is dropped, cooled down, and the recommendation marked `ROLLED_BACK`.
An index that survives the window graduates (the watch stops).

**Undo**: a `DROPPED` recommendation can be rolled back from the dashboard — the
index is rebuilt from the spec captured at drop time (`rollbackToken`) and the
ROI headline is corrected back down.

Every executed operation writes an **immutable `actions` row** (actor, result,
rollback token). In **read-only mode** (default on) the pipeline computes everything
but never writes to your cluster.

## Policy knobs (per cluster)

| knob | effect | default |
|------|--------|---------|
| `readOnly` | compute everything, never write (owner-toggled) | on |
| `autoApply` | approve recommendations without a human | off |
| `workloadAnalysis` | enable the create/merge/update engine | off |
| `instantCreate` | auto-build critical missing indexes | off |
| `observeWindowDays` | how long a hidden index bakes before drop | 30 |
| `maxCollectionSizeBytes` | size ceiling for touching a collection | — |

Knobs are edited from the dashboard's **Policy** section (`GET/PUT
/clusters/:id/policy`, owner-only writes). With `autoApply`, proposed
recommendations are promoted automatically — the hide → observe → finalize
gates still stand between them and any drop.

## Connecting a customer cluster

See [`docs/mongo-user.md`](./docs/mongo-user.md) — the exact `createRole`
snippets for the index-only user (analyze-only first, live-manage when you go
live). Indexterity never gets document read/write privileges.

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

## Auth & tenancy

Every api endpoint requires a better-auth session and is scoped to the caller's
org. The dashboard is a BFF: it proxies `/api/auth` to the api so the session
cookie lives on the web origin, then forwards that cookie to the api on every
data call. Set `WEB_ORIGIN` (api) and `VITE_WEB_ORIGIN` (web) to the dashboard's
public origin so better-auth trusts it as a request origin.

**Teams & roles**: invite a teammate from the dashboard — the api returns a
one-time token (7-day expiry) to share; they join with it. If their only org is
the empty auto-created one, it's replaced by the org they join; a user's oldest
membership is their active org. The org creator is **owner**; invited users are
**members**. Members read everything; mutations (connect cluster, mode toggle,
approve, undo, collect, invite) are owner-only (403 otherwise).

**Email**: with `SMTP_*` configured (see `.env.example`), invites are emailed
to the invitee and owners get engine alerts (drops executed, regressions rolled
back). Without SMTP config, sending is a logged no-op.

**Hardening**: auth endpoints are rate-limited (20/min per IP; 300/min global),
connection strings must be `mongodb://`/`mongodb+srv://` (SSRF guard), and a
daily retention job prunes latency samples + index snapshots past
`RETENTION_DAYS` (default 90).

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

Other: `npm run build` · `npm run typecheck` · `npm run lint` · `npm run test`
(unit — the pure engines).
Database: `npm run db:generate` · `npm run db:migrate`.

**Integration tests** (spawn the built api against real postgres + mongo — the
same suite CI runs with service containers):

```bash
npm run build
DATABASE_URL=postgres://… MONGO_URL=mongodb://localhost:27017 \
  npm run test:int -w @repo/api
```

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

## Roadmap (Mongo-focused)

Engine depth, roughly in order:

1. **Collation-aware redundancy** — exact same-key duplicates turn out to be
   impossible (mongod rejects the create with `IndexKeySpecsConflict`; verified
   live). The real twin is same-keys-different-*collation*, which is legal and
   invisible to the engine until `IndexSpec` models collation.
2. **Replica-aware ROI** — a dropped index frees its bytes on *every*
   replica-set member; the headline currently counts one copy. Multiply by
   member count (already collected per snapshot).
3. **Aggregation shapes** — workload analysis parses `find` filters; parse the
   `$match`/`$sort` stages of `aggregate` shapes from `$queryStats` too.
4. **Create cost estimate** — CREATE recommendations should show the price:
   estimated index size (doc count × key size) and write amplification, next to
   the read win.
5. **Wire `maxCollectionSizeBytes`** — the knob exists and is editable; the
   engine doesn't read it yet.
6. **Advisory tier** — unique/TTL indexes that look unused are never touched;
   surface them as "review manually" advisories instead of staying silent.
7. **Partial/TTL suggestions** — profiler samples carry real filter values;
   always-`status:"active"` queries justify a partial index, monotonic date
   ranges a TTL review.
8. **Sort-direction-aware ESR** — compound keys are all-ascending today; mixed
   `sort {a: 1, b: -1}` needs matching index directions.
9. **Atlas onboarding** — create the index-only user via the Atlas Admin API
   instead of asking customers to paste `createRole` snippets.
10. **Read-only digest** — a weekly "here's what we *would* have done" email
    for clusters still in read-only mode; the go-live conversion driver.

## Notes

The repo uses **npm workspaces**.
- **zod is pinned to v3** — `@ts-rest/*` peers require `^3.22.3`. Revisit when
  ts-rest ships zod 4 support.
- **Docker** resolves to **podman** + `podman-compose` on this machine; the
  compose file is standard and works with either.
</content>
</invoke>
