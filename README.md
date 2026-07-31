# Indexterity

**Indexterity** — index dexterity for MongoDB. A SaaS that continuously watches MongoDB indexes and manages them safely — drop
unused/redundant, merge overlapping, extend prefixes, create missing — and proves
the result in hard numbers. Read-only by default; the one irreversible step (a
drop) is gated behind an observe window, a double pre-flight, and a read-latency
regression check. Full design and decision log in
[`docs/architecture.md`](./docs/architecture.md).

## What it does

1. **Connect** a cluster by pasting any connection string. Indexterity first
   **checks what that string can actually do** — nothing is stored or written
   yet — and tells you per privilege what works, what is degraded and what is
   missing. If the credentials can create users, it **asks** whether to
   provision its own least-privilege user (`idx_<hex>`, custom
   `indexterityEngine` role — no `find` on your collections, so it **cannot
   read documents**; the exact role is in
   [`docs/architecture.md` §10.1](./docs/architecture.md)); the admin string is
   then used once and never persisted, and only the scoped string is stored,
   sealed with envelope encryption. Clusters start in **read-only mode** — the
   engine analyzes but never writes until an owner flips it live (dashboard
   toggle).
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
7. **One dashboard** (at `/app`; `/` is the landing page): recommendations with
   approve/undo, read/write latency charts, a per-collection table (index
   count, on-disk index size, latency trend, open proposals), **per-index ROI
   attribution** (which drop earned what, undo netted out), the immutable
   activity trail, the policy editor, team & invites, an **org switcher** for
   multi-org users, and a cluster picker with the read-only ⇄ live toggle plus
   **disconnect** (offboarding restores any still-hidden indexes, deletes all
   collected data, and hands you the command to revoke the provisioned user).

## How it decides

Two independent engines, both **pure functions in `apps/api/src/analysis`** — no
I/O, so they are deterministic and unit-tested without a database or a cluster.

Everything engine-specific sits behind **engine ports**
(`apps/api/src/engine/ports.ts`): a read-only stats collector, the one write
surface (executor), and a per-cluster adapter registry. MongoDB is the shipped
adapter; the data model and contracts already carry an `engine` field so
PostgreSQL / SQL Server adapters can slot in without pipeline changes
([`docs/architecture.md` §9](./docs/architecture.md) has the mapping:
`pg_stat_user_indexes` / `sys.dm_db_index_usage_stats` etc.).

### At a glance — the drop decision

```mermaid
flowchart TD
    S[Index snapshots and usage history] --> H{History trustworthy?<br/>3+ snapshots, no gap over 48h,<br/>no counter restart in the window}
    H -- no --> HX[No usage-based finding —<br/>absence of evidence only counts<br/>if we were watching]
    H -- yes --> P{Protected?<br/>_id_ / unique / TTL / shard / partial / sparse}
    P -- yes --> PZ{Zero usage, or a unique index<br/>prefixing a wider one?}
    PZ -- yes --> ADV[ADVISORY_REVIEW<br/>never auto-dropped]
    PZ -- no --> K1[Keep]
    P -- no --> R{Directed key-prefix of a wider index,<br/>same collation?}
    R -- yes --> DR[DROP_REDUNDANT]
    R -- no --> U{Usage class from history}
    U -- FLAT_ZERO or PERIODIC_DEAD --> DU[DROP_UNUSED]
    U -- CONTINUOUS or PERIODIC_ALIVE --> K2[Keep]
    DR --> SC[Confidence score 0 to 100<br/>past regressions subtract 40 each]
    DU --> SC
    SC --> PIPE[Safety pipeline below]
```

### At a glance — the create decision

```mermaid
flowchart TD
    W[Query shapes from queryStats or profiler] --> REC{Recurring?<br/>at least 3 sightings}
    REC -- no --> X0[Ignored — an ad-hoc heavy query<br/>never leaves an index behind]
    REC -- yes --> CS{COLLSCAN and collection<br/>at least 1000 docs?}
    CS -- no --> X1[Ignored]
    CS -- yes --> ESR[ESR key order:<br/>Equality then Sort then Range]
    ESR --> PA{Equality field compared to the<br/>same literal in every sample?}
    PA -- yes --> PF[Predicate moves into<br/>partialFilterExpression]
    PA -- no --> CO
    PF --> CO{Directed prefix of<br/>another proposal?}
    CO -- yes --> FOLD[Consolidated into the wider proposal<br/>counts add up]
    CO -- no --> KI{Against existing indexes}
    KI -- equal exists --> N0[Nothing to do]
    KI -- an index prefixes the want --> UPD[UPDATE — extend it]
    KI -- two or more singles cover it --> MRG[MERGE into one compound]
    KI -- otherwise --> CRE[CREATE]
    L[Lookup joins in pipelines] --> FI{Foreign join field indexed?}
    FI -- no --> CRF[CREATE on the foreign collection]
```

### Removing indexes (usage + redundancy)

Runs off collected snapshots. First each index gets a **usage class** from its
op-count history:

- needs **≥ 3 snapshots** (below that no usage claim is made at all)
- ops are summed **across all replica-set members** per snapshot
- no snapshot has ops → `FLAT_ZERO`
- every snapshot has ops → `CONTINUOUS`
- some do, and the last 3 have ops → `PERIODIC_ALIVE`
- some do, but the last 3 are silent → `PERIODIC_DEAD` (e.g. a monthly job that
  got decommissioned)

**Usage claims need a history worth trusting.** Fewer than 3 snapshots, a hole
larger than 48 hours, a newest snapshot older than that, **or a counter that
restarted** — and no usage-based finding is made at all. During a collection
gap, and equally in the moments after a mongod restart, a busy index looks
exactly like a dead one: each snapshot records every member's
`$indexStats.accesses.since`, so a reset is seen rather than guessed.
Redundancy findings are structural and unaffected.

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
**≥ 10 000 docs** is "critical". A shape must recur — **≥ 3 sightings** —
before it earns anything, so someone manually running a heavy query once or
twice never leaves an index behind. For each recurring shape that did a
`COLLSCAN`:

- an existing index already equals the wanted fields → nothing
- an existing index is a proper prefix of the wanted fields → **UPDATE** (extend it)
- two or more single-field indexes cover the fields → **MERGE** into one compound
- otherwise → **CREATE**

**Partial indexes**: when the profiler shows an equality field compared against
the *same literal in every sample* (the `status: "active"` pattern), that
predicate moves into a `partialFilterExpression` and out of the keys — a
smaller index serving the same query. Profiler-only: `$queryStats` shapifies
values away, so it can't provide this signal.

**TTL advisories**: recurring age-based deletes in the profiler
(`deleteMany({createdAt: {$lt: …}})`, ≥ 3 sightings) produce an advisory with
the estimated retention window and the exact `createIndex` command. **Never
auto-built** — a TTL index deletes documents, the one thing Indexterity
promises never to touch; you review and run it yourself. Detection ignores the
collection-size gate on purpose: a pruned collection is small *by design*.

**Consolidation**: proposed indexes that are a directed key-prefix of another
proposal fold into the wider one (one index serves both shapes; the survivor
inherits the narrower shapes' counts) — three overlapping shapes become one
recommendation, not three.

**$lookup joins**: aggregations joining another collection
(`localField`/`foreignField` form, from `$queryStats` or the profiler) produce
a CREATE on the **foreign** collection's join field when no index leads with
it — without one, every joined document scans the foreign collection.

**Collation-aware redundancy**: `IndexSpec` models the index collation; a
key-prefix under a different collation is never flagged redundant (it serves
different queries), and undo restores the original collation.

**Unique-prefix advisories**: a unique index whose keys prefix a wider index
stores redundant data, but dropping it would lose the uniqueness constraint —
flagged as an advisory (drop it yourself, or make the wider index unique);
never auto-dropped.

### Instant apply

A `CREATE` on a critical collection, when `policy.instantCreate` is on, the
cluster is live (not read-only), and the shape recurred **≥ 5 times**, is
auto-approved and built immediately — adding an index is safe and reversible,
so a critical missing index does not wait for the next scheduler tick.
**Drops are never instant.**

## The apply pipeline (state machine)

`PROPOSED → APPROVED` (dashboard, or auto), then it depends on the type.

```mermaid
stateDiagram-v2
    [*] --> PROPOSED: engine proposes, scored 0 to 100
    PROPOSED --> APPROVED: dashboard, autoApply, or score at least autoApplyScore
    APPROVED --> HIDDEN: drop path — pre-flight, then hide (inside the change window)
    HIDDEN --> REJECTED: reads regressed — un-hidden + cooldown
    HIDDEN --> PROPOSED: pre-flight failed — un-hidden, re-proposed
    HIDDEN --> DROPPED: dynamic observe window elapsed — drop (inside the change window)
    DROPPED --> ROLLED_BACK: undo — rebuilt from the rollback token
    APPROVED --> ACTIVE: create path — build (inside the change window)
    ACTIVE --> ROLLED_BACK: writes regressed — dropped + cooldown
    ACTIVE --> [*]: survives the watch window — graduates
```

**Removals** (`DROP_UNUSED` / `DROP_REDUNDANT` / `MERGE` retire):

```
APPROVED → pre-flight → hide (collMod hidden:true) → HIDDEN → observe → finalize → DROPPED
```

- Hiding is instant and reversible, and starts the observe window.
  `policy.observeWindowDays` (default **30**) is the *baseline*: at hide time
  the window is derived from the index's own usage history — **periodic usage
  extends it** to 2× the largest gap between active snapshots (≤ 90 days, so a
  monthly job gets a full cycle inside the window), and an index **proven idle**
  across at least twice the baseline shortens it to half (never under a week).
  The decided window and its reason land in the audit trail.
- At hide time the collection's **baseline read latency** is recorded.
- `finalize` runs only after the window elapses and gates the drop three ways:
  0. **Observability** — `$collStats` counters are cumulative *since mongod
     started*, so a restart mid-window (common during a long outage) leaves a
     baseline that no longer relates to them. That reads as **UNOBSERVABLE**,
     never as "no regression": the index is **un-hidden and re-proposed**
     rather than dropped on evidence that no longer exists.
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
| `observeWindowDays` | baseline bake time for a hidden index — auto-extended for periodic usage (2× the largest activity gap, ≤ 90d), auto-shortened for long-proven idleness (≥ half, ≥ 7d) | 30 |
| `maxCollectionSizeBytes` | size ceiling for building new indexes | — |
| `autoApplyScore` | auto-approve recommendations scoring ≥ this (0-100) | off |
| `changeWindowStartHour` / `EndHour` | elective changes (hide/build/drop) only run in this UTC hour window; safety rollbacks never wait | anytime |

Knobs are edited from the dashboard's **Policy** section (`GET/PUT
/clusters/:id/policy`, owner-only writes). With `autoApply`, proposed
recommendations are promoted automatically — the hide → observe → finalize
gates still stand between them and any drop.

**Confidence scores.** Every recommendation carries a 0-100 score: drops earn
points from dead usage, redundancy, history depth and reclaimable size; creates
from scan frequency and collection size; past regressions on the same index cut
the score hard. The score gates *entry* (what gets proposed, what auto-approves
via `autoApplyScore`) — never the safety stages: an auto-approved drop still
goes hide → observe → regression/pre-flight before anything is deleted, and
advisories never auto-approve.

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
better-auth · Drizzle + PostgreSQL · oRPC contracts (zod 4) · graphile-worker ·
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

packages/contracts      oRPC + zod 4 contracts shared by api and web (the one shared type boundary)
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

**House rule: the api and the web app run clean.** No errors and no warnings in
server logs, build output, or the browser console — a warning is a defect, so
fix the cause rather than silencing it. Expected external conditions (an
unreachable cluster, undecryptable credentials) are classified and handled, not
thrown and retried; anything clock- or timezone-dependent in the UI waits for
`useMounted()` so hydration matches. See architecture §16.
Database: `npm run db:generate` · `npm run db:migrate` (dev, via drizzle-kit) ·
`npm run db:deploy -w @repo/api` (production — runs the compiled migrator, no
devDependencies needed).

## Security posture (defaults)

Both defaults exist because the control plane **dials hosts that users name**:

- **Sign-up is invite-only** (`SIGNUP_MODE`). The first account bootstraps the
  install; after that an address needs a pending invite. `open` and `closed`
  are the alternatives — `open` hands that outbound reach to strangers.
- **Private targets are refused** unless `ALLOW_PRIVATE_CLUSTER_TARGETS=true`
  (self-hosted installs whose database is on the same private network). Cloud
  metadata and other never-a-database ranges stay blocked either way, DNS and
  SRV records are resolved before dialing, and every host in a multi-host
  string is checked. Details in
  [`docs/architecture.md` §10.2](./docs/architecture.md).

## Deploy on Kubernetes

A Helm chart lives in [`deploy/helm/indexterity`](./deploy/helm/indexterity):
api + dashboard + worker, a pre-upgrade migration hook, ingress, and a
`helm test` that probes both services. PostgreSQL is not bundled — point it at
your own.

```bash
helm install indexterity deploy/helm/indexterity \
  --namespace indexterity --create-namespace \
  --set api.image.repository=your-registry/indexterity-api \
  --set web.image.repository=your-registry/indexterity-web \
  --set secrets.databaseUrl='postgres://user:pass@host:5432/indexterity' \
  --set secrets.betterAuthSecret="$(openssl rand -base64 32)" \
  --set secrets.masterKey="$(openssl rand -base64 32)" \
  --set ingress.enabled=true --set ingress.host=indexterity.alivlad.com
```

The api never has to be public — browsers only reach the dashboard, whose
server functions call the api in-cluster. **Back up `MASTER_KEY`**: it seals
every stored connection string. See the
[chart README](./deploy/helm/indexterity/README.md) for the full value list.

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
docker build -f apps/api/Dockerfile -t indexterity-api .
docker build -f apps/web/Dockerfile -t indexterity-web .
```

api ≈ 390 MB, web ≈ 235 MB. **One web image serves every environment**: `API_URL`
and `WEB_ORIGIN` are read at runtime (the dashboard's server functions are the
only thing that calls the api), with the `VITE_*` build args as defaults. The
worker deploys from the api image with `CMD ["node", "apps/api/dist/worker.js"]`.

## Roadmap (Mongo-focused)

Engine depth, roughly in order:

1. ~~Collation-aware redundancy~~ — shipped: collation is modeled, captured
   from `listIndexes`, respected by the redundancy rule and restored on undo.
   (Exact same-key duplicates remain impossible — mongod rejects them.)
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
7. ~~TTL suggestions~~ — shipped as advisories from the recurring-delete
   signal (see above).
8. **Atlas onboarding** — create the index-only user via the Atlas Admin API
   instead of asking customers to paste `createRole` snippets.
9. **Read-only digest** — a weekly "here's what we *would* have done" email
    for clusters still in read-only mode; the go-live conversion driver.

## Notes

The repo uses **npm workspaces**.
- Contracts run on **oRPC + zod 4** (migrated from ts-rest/zod 3 — paths were
  kept stable, so external callers and the integration suite were unaffected).
- **Docker** resolves to **podman** + `podman-compose` on this machine; the
  compose file is standard and works with either.
</content>
</invoke>
