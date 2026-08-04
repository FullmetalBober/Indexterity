# Architecture — MongoDB Index Optimizer (working title)

**Status:** Draft v1 · **Last updated:** 2026-07-22

This document locks the architecture and the key decisions behind them. It is the
source of truth for the initial build. Update the Decision Log at the bottom when
anything here changes.

---

## 1. Product

A SaaS that continuously monitors MongoDB indexes and safely manages them:
create missing indexes, drop unused ones, remove redundant ones, and merge
overlapping ones — while proving the improvement in hard numbers.

**Problem.** Teams add indexes over time and almost never remove them. Every
index slows writes (each write updates every index), consumes RAM (working set)
and disk, and nobody audits `$indexStats`. The cost is a slow burn, so it is
rarely acted on.

**Wedge / differentiation.**

- MongoDB Atlas *Index Autopilot* only auto-**creates** indexes. It recommends
  removals but never auto-drops them (dropping is dangerous), and it is
  **Atlas-only**.
- Our edge is the part Atlas leaves manual: **safe auto-cleanup** (drop unused /
  redundant, merge), **self-hosted + multi-cloud coverage**, and a
  **cross-provider ROI dashboard**.
- Second edge: an **index-only permission model** means we never read customer
  data rows — a strong trust story Atlas does not need to make.

Do **not** compete on auto-create on Atlas. Compete on safe cleanup everywhere.

---

## 2. Principles

1. **Safety is asymmetric.** Keeping a useless index is mild waste; dropping a
   needed one is an outage. Every ambiguous call biases toward *keep*.
2. **Read-only by default.** Demo/read-only is structural, not a UI toggle. The
   data plane refuses all writes to a cluster unless that cluster is explicitly
   taken out of demo mode.
3. **Deletion is a confirmed, reversible pipeline** — never a single command.
4. **No customer data exposure** in the cleanup path. Index metadata and usage
   stats only; no `find`.
5. **ROI must be visible.** Every action reports before/after. No visible ROI,
   no renewal.
6. **Fully typed.** No `any`, no `as` overrides, no linter-ignore comments.
   Latest stable versions of every dependency. Comments stay short.

---

## 3. Tech stack

| Layer | Choice | Role |
|-------|--------|------|
| API (control plane) | **NestJS + Fastify** | orchestration, tenancy, apply engine |
| Engine adapters | **ports + registry** (`src/engine`, §9) | MongoDB shipped; PostgreSQL/MSSQL planned |
| Web (dashboard) | **TanStack Start** + **shadcn/ui** | dashboard UI |
| Auth | **better-auth** | GitHub OAuth + email/password |
| ORM / migrations | **Drizzle** | Postgres schema + migrations |
| App database | **PostgreSQL** | control-plane state (not the managed DBs) |
| Monorepo | **Turbo** | build/task orchestration |
| Lint/format | **Biome** | one tool, strict |
| API contracts | **oRPC** (`@orpc/contract` + `@orpc/nest` + OpenAPILink client) | typed contracts shared api ↔ web ↔ agent, zod 4 |
| Data fetching (web) | **TanStack Query** (+ `@tanstack/react-router-ssr-query`) | every read and every write; the ssr-query package carries the cache across SSR (§14.2) |
| Job queue | **graphile-worker** | Postgres-backed jobs (no Redis) |
| Crypto | **@noble/ciphers** | envelope encryption for secrets |
| Metrics | **OpenTelemetry** (`@opentelemetry/sdk-metrics` + Prometheus exporter, wired once in `packages/metrics`) | api, worker and web each scraped on their own port (§15.1); alerts ship with the chart (§15.2) |
| Container | **Docker** | separate api/web images, compose for dev |

Postgres stores **our** state. The databases we manage are the customers'
**MongoDB** clusters, reached via the data plane. Clean separation.

Versions are pinned to latest stable at scaffold time — this doc does not hard-code
version numbers so it does not go stale.

---

## 4. Topology — control plane / data plane

The spine of the system. The **control plane** (our SaaS) never touches customer
MongoDB directly in agent mode; it decides and displays. The **data plane** is the
only component that touches MongoDB, using an **index-only role**.

```
 CUSTOMER INFRA (private)            OUR SaaS (control plane)          BROWSER
┌───────────────────────┐          ┌──────────────────────────┐     ┌──────────┐
│  MongoDB replica set  │          │  apps/api (NestJS+Fastify)│     │ apps/web │
│  ┌─────┐ ┌─────────┐  │          │   - accounts / tenancy    │◄───►│ TanStack │
│  │prim.│ │secondary│  │          │   - recommendations       │oRPC │  Start   │
│  └──┬──┘ └────┬────┘  │          │   - apply orchestrator    │     │ +shadcn  │
│     │        │        │          │   - audit + ROI           │     └──────────┘
│  ┌──▼────────▼──────┐ │  HTTPS   │   - job queue (graphile)  │
│  │  DATA PLANE      │ │◄────────►│                           │
│  │  collector +     │ │ outbound │  PostgreSQL (Drizzle)     │
│  │  executor        │ │  only    │  secrets (envelope enc)   │
│  │  (index-only role)│ │(agent mode)                         │
│  └──────────────────┘ │          └──────────────────────────┘
└───────────────────────┘
```

### Connection modes (same data-plane interface, two implementations)

- **Hosted-direct — v1.** Customer pastes a MongoDB connection string (SRV URI,
  index-only role) into the dashboard. Our servers connect out over TLS. Fastest
  onboarding; self-serve. Requires their cluster be reachable from us (public
  endpoint or IP allowlist) and that they trust us to hold creds (encrypted).
- **Agent — phase 2.** Customer runs a small container inside their network. It
  talks to MongoDB locally and phones home outbound-only. MongoDB is never
  exposed; creds never leave customer infra. Enterprise trust tier.

The data plane is defined by **one interface**; hosted-direct and agent are two
implementations. Building hosted-direct first does not preclude the agent — it is
an additive second implementation, not a rewrite.

---

## 5. Monorepo layout (Turbo)

```
apps/
  api/          NestJS + Fastify — control plane
  web/          TanStack Start + shadcn — dashboard
  agent/        deployable collector + executor (phase 2; same iface as hosted)
packages/
  core/         PURE analysis + safety engine. No I/O. Heavily tested. ← the heart
  mongo/        driver wrapper: collect $indexStats, execute create/drop/hide
  db/           Drizzle schema + migrations (Postgres) + secret sealing
  contracts/    oRPC contracts + zod 4 schemas (shared types api ↔ web ↔ agent)
  auth/         better-auth config (GitHub + email/password)
  config/       shared tsconfig + Biome config
  metrics/      OpenTelemetry provider + scrape endpoint (§15.1); instruments stay in the apps
```

`packages/core` holds all dangerous logic as **pure functions**:
`(indexes + usage snapshots) → classified recommendations`. No database, no
network. Pure means deterministic, testable, and trustworthy. This package gets
the deepest test coverage.

---

## 6. Core domain — the analysis engine

### 6.1 Recommendation types

| Type | Trigger | Risk |
|------|---------|------|
| `DROP_UNUSED` | ~0 ops over the observation model | medium |
| `DROP_REDUNDANT` | index is a prefix of another, options compatible | medium |
| `MERGE` | two indexes replaceable by one superset | medium |
| `CREATE` | workload needs it (phase 2 — needs profiler) | low (additive) |
| `UPDATE` | option change (e.g. add partial filter) | low |

### 6.2 Usage detection — the subtlety that causes outages if wrong

`$indexStats.accesses.ops` is **cumulative since that mongod last restarted**, and
it is **per-member**. Consequences the engine must handle:

- **Snapshot over time.** Periodically snapshot `$indexStats` into Postgres and
  compute rolling-window usage from the deltas. A single reading is meaningless.
- **Detect restarts.** *Implemented* (`countersRestartedDuring`): every snapshot
  persists each member's `accesses.since` — the moment that member's counter
  started — so classification can see a reset rather than infer one. A window is
  distrusted when `since` advances for any member across it, or when the newest
  counters are younger than the window itself (they cannot account for a period
  they did not exist for). Either way no usage-based finding is made. Snapshots
  written before the field existed carry none and are skipped, so the check
  never invents evidence.
- **Aggregate across all replica-set members.** Secondaries serve reads with
  different index usage than the primary. Reading only the primary and dropping an
  index a secondary relies on is a classic outage. Sum usage across primary + all
  secondaries before concluding "unused".

### 6.3 Usage classification by time series

Classify each index from its usage history, not a single number:

| Class | Signal | Action |
|-------|--------|--------|
| `CONTINUOUS` | regular ops | keep |
| `PERIODIC_ALIVE` | bursts on a detected cycle, latest expected burst **present** | keep — never drop |
| `PERIODIC_DEAD` | had a cycle, then **≥N expected bursts missed** | propose drop, move faster |
| `FLAT_ZERO` | long zero, no detectable pattern | standard window |

To label a pattern **dead** (rather than "hasn't fired this cycle yet"), the engine
must first *learn the period* (needs ≥2–3 observed periods of history), then observe
**N expected occurrences that did not happen**. Example: an index that fires around
the 1st of each month — if two consecutive month-starts pass with zero ops, the
workload is decommissioned → propose drop.

This is both **safer** (a flat window would wrongly flag a live monthly index during
a quiet stretch) and **faster** (a genuinely dead pattern can be dropped without
waiting the full conservative window). Before enough history exists to detect a
cycle, fall back to `FLAT_ZERO` rules.

### 6.4 Redundancy / merge rules

An index is redundant when it is a **proper prefix** of another compound index —
e.g. `{a:1}` is covered by `{a:1, b:1}`. But prefix match alone is not sufficient;
the classifier must confirm **option compatibility**, or it will drop something
that does more than accelerate queries:

- Sort direction of the shared prefix keys must match.
- A **unique** `{a:1}` is *not* redundant against a non-unique `{a:1, b:1}` — it
  enforces a constraint. Same for differing `partialFilterExpression`, `collation`,
  `sparse`, TTL, or index type (text/geo/wildcard).

`MERGE` is the inverse: when two indexes are each partially useful, propose a single
superset index that covers both, then retire the two — via the same apply pipeline.

### 6.5 Safety classifier — the never-auto-drop list

Hard block. These are never eligible for an automated drop, regardless of usage:

- The `_id_` index (mandatory).
- **Unique** indexes — they enforce a constraint; zero query ops does **not** mean
  unused. Dropping one can allow data corruption.
- **TTL** indexes — they expire documents; low query usage is expected.
- **Shard key** indexes — the cluster breaks without them.
- Partial / sparse indexes serving a constraint.
- Any index younger than the observation window (insufficient data).
- Any index used on **any** replica-set member.

Bias: when uncertain, keep.

---

## 7. Apply pipeline — safety-critical

Every recommendation moves through an explicit state machine. Ordering is part of
the safety guarantee.

### 7.1 Drops (reversible until the final step)

```mermaid
stateDiagram-v2
    [*] --> PROPOSED
    PROPOSED --> APPROVED: human, or opted-in auto-policy
    APPROVED --> HIDDEN: collMod hidden:true (instant, reversible)
    HIDDEN --> OBSERVE: grace window, watch for regressions
    OBSERVE --> APPROVED: regression detected → un-hide, re-evaluate
    OBSERVE --> DROPPED: clean window + human confirm
    DROPPED --> [*]
```

1. `PROPOSED` — shown with rationale and estimated savings.
2. `APPROVED` — by a human, or by an auto-policy only where the customer opted in
   for that class of action.
3. `HIDDEN` — execute `collMod { hidden: true }`. Instant and fully reversible. The
   planner stops using the index; the index still exists.
   > Note: a hidden index is **still maintained on writes** and still consumes disk
   > and RAM. Hiding yields no write/space benefit — it is purely a safety probe.
   > Real benefit arrives only at `DROPPED`.
4. `OBSERVE` — grace window (default 30d, see §7.3). Watch for query-latency
   regressions or errors. On any degradation, un-hide instantly (one `collMod`) and
   re-evaluate.
5. `DROPPED` — only after a clean observe window, and always human-confirmed. This
   is the sole irreversible step.

### 7.2 Creates

```mermaid
stateDiagram-v2
    [*] --> SCHEDULED
    SCHEDULED --> BUILDING: maintenance window (rolling)
    BUILDING --> ACTIVE
    BUILDING --> ROLLED_BACK: build harms performance → drop
    ACTIVE --> [*]
```

Creates are scheduled into a maintenance window (a rolling build still drives I/O
and can cause replication lag). The build spec is retained as a rollback token: if
the build harms performance, drop it.

### 7.3 Observe / grace window

- **Default 30 days.** 7 days catches daily and weekly patterns but misses monthly
  jobs (billing, month-end reports); dropping an index a monthly job needs causes an
  outage weeks later. 30 days catches monthly. The cost of waiting is only *delayed*
  benefit, never lost benefit — outage from dropping too soon is real damage.
- **Adaptive down.** If ≥90 days of zero-usage snapshots already exist for the
  index, shorten the window and drop with confidence.
- **Pattern-aware.** `PERIODIC_DEAD` (see §6.3) can proceed faster; `PERIODIC_ALIVE`
  never proceeds.
- **Configurable** per policy (a customer who knows there are no monthly jobs may
  set 7 days).

### 7.4 Execution-time pre-flight (defense in depth)

The world changes between recommendation and execution. Immediately before any
hide/drop, the executor re-fetches live stats and re-runs the classifier against the
current index spec. If the index is no longer unused, its options changed, or it is
now unique/TTL — **abort and re-propose**. Classification is centralized in `core`;
this final re-check runs at the executor.

### 7.4.1 Losing the cluster mid-pipeline

An outage of days or weeks is the case where a safety gate is most likely to be
wrong, because the counters it compares are **cumulative since mongod started**.

- **Restart during the window.** `current.ops < baseline.ops` means the numbers
  are from a different process lifetime. `evaluateRegression` returns
  **UNOBSERVABLE** — never STABLE — and finalize **un-hides and re-proposes**
  the drop instead of taking the one irreversible action on a window it never
  saw. The same reading also releases an index that sat hidden through the
  outage. On the create side the write watch re-baselines and restarts rather
  than graduating unchecked, and graduation is only evaluated *after* a real
  reading.
- **No restart, just nobody watching.** The counters kept climbing, so the
  observation is still valid — the window merely lasted longer. Nothing special
  happens, which is correct.
- **Usage history with a hole.** Snapshots stop and resume. `classifyUsage`
  cannot tell a busy index from a dead one across a gap, so
  `usageHistoryIsTrustworthy` (≥ 3 snapshots, no gap beyond `maxGapHours`,
  newest within it) gates every usage-based finding. Structural findings
  (redundancy, unique-prefix) are unaffected. This also stops a brand-new
  cluster from proposing a drop for every index on its first collect.
- **Noise.** A cluster that stays unreachable fails collect every 6h forever;
  owner alerts are capped at one per cluster+task per day.
- **Visibility.** `cluster.lastCollectedAt` feeds a staleness badge, so figures
  from before a gap cannot read as current.

### 7.5 "Instant apply" for critical indexes — scoped

Restricted to **creation only** — never an instant drop. "Critical" is defined
narrowly: an index that resolves a collection scan on a large, hot collection during
an active latency incident. Even then it is gated behind per-cluster opt-in and a
maximum-collection-size threshold, and logged prominently. Drops never skip the
hide → observe → drop path, regardless of urgency.

---

## 8. Verification & ROI

After each action, measure before/after and persist to `roi_metrics`:

- RAM / working-set and disk bytes freed (`collStats`, `$indexStats`).
- Write-throughput delta (fewer indexes → faster writes).
- Index-count trend.

The dashboard headline is these hard numbers.

---

## 9. Engine ports — multi-database architecture

The decision core never touches a database driver. Everything engine-specific
sits behind two ports plus a session factory (`apps/api/src/engine/ports.ts`):

- **`IndexCollector`** — the read-only statistics surface (usage, sizes,
  latency, workload shapes, delete patterns). Deliberately contains nothing
  that can read customer data rows. Every method is per namespace except
  `collectWorkload`, which takes them all at once: each engine's workload source
  is one cluster-wide store you filter per namespace (`$queryStats`,
  `pg_stat_statements`), so a per-collection signature invites reading the whole
  store once per collection.
- **`IndexExecutor`** — the only write surface (hide/unhide/drop/create);
  implementations must enforce read-only mode structurally.
- **`EngineSession`** — a pooled connection exposing both, plus
  `listDatabaseNames()` (system namespaces pre-filtered per engine) and
  `ping()` (rotation's verification probe).
- **`EngineAdapter`** — connection-string validation (the SSRF guard) +
  `open()`, registered per engine in `src/engine/registry.ts`. The
  `clusters.engine` column picks the adapter per cluster; adding an engine is
  one new adapter directory plus one registry line, with zero pipeline changes.

The analysis core (`src/analysis`) is pure and engine-neutral; the jobs, the
connection pool, and the API speak only the ports. MongoDB
(`src/mongo/adapter.ts`) is the shipped reference adapter. Vocabulary stays
MongoDB-flavored ("database", "collection") — relational adapters map their
terms (schema, table) rather than the codebase adopting a
lowest-common-denominator vocabulary.

### 9.1 Planned adapter mapping

| Port concept | MongoDB (shipped) | PostgreSQL (planned) | SQL Server (planned) |
|---|---|---|---|
| Usage stats | `$indexStats` | `pg_stat_user_indexes.idx_scan` | `sys.dm_db_index_usage_stats` |
| Sizes + row counts | `$collStats storageStats` | `pg_relation_size` / `pg_stat_user_tables` | `sys.dm_db_partition_stats` |
| Read/write latency | `$collStats latencyStats` | `pg_stat_statements` aggregated per table | Query Store runtime stats |
| Workload shapes | `$queryStats` / profiler | `pg_stat_statements` normalized queries | Query Store query texts |
| Reversible hide | `collMod hidden: true` | **none native** (see capabilities) | `ALTER INDEX … DISABLE` (re-enable = `REBUILD`) |
| Online create | `createIndex` | `CREATE INDEX CONCURRENTLY` | `WITH (ONLINE = ON)` |
| Scoped user | `createRole` + `createUser` | `CREATE ROLE` + `pg_monitor` + index DDL grants | `CREATE LOGIN/USER` + `VIEW SERVER STATE` + `ALTER` |

### 9.2 Capability flags

`EngineCapabilities` marks where engines genuinely differ, so feature gates
check a flag instead of assuming MongoDB semantics deep in the pipeline:

- **`hideIndexes`** — the safety pipeline's observe stage rides on cheap,
  reversible invisibility. SQL Server has an analogue (`DISABLE`, undone by a
  rebuild — reversible but not free). PostgreSQL has none: its adapter will
  need an alternative observe mechanism (extended stats-only observation
  before an irreversible `DROP INDEX CONCURRENTLY`, with the undo path being
  a scripted recreate from the rollback token).
- **`provisionScopedUsers`** — admin-string onboarding (§10.1). Each engine's
  provisioning is inherently engine-specific commands/SQL.

## 10. Security

### 10.1 Index-only MongoDB role — no data-row access

The data plane connects with a custom role granting only index management and
stats, excluding `find` / `insert` / `update` / `remove` on customer
collections. It therefore cannot read customer documents — enforced by the
server, not by promise.

**Automated (admin-string onboarding).** `POST /clusters/provision` accepts an
admin connection string, uses it ONCE to create the role + a dedicated user
(`idx_<hex>`) on the customer cluster, verifies the scoped credentials
authenticate, and stores only the scoped string (sealed, §10.3). The admin
string is never persisted. Re-provisioning refreshes the role's privileges via
`updateRole`, so app updates can evolve the grant. The exact role
(`apps/api/src/mongo/provision.ts`, live-verified against an `--auth` mongod —
every engine command allowed, every document access denied):

```js
db.getSiblingDB("admin").createRole({
  role: "indexterityEngine",
  privileges: [
    // Un-transformed $queryStats needs BOTH actions (verified on mongo 8).
    // serverStatus is the health probe — server-wide, and the one grant here
    // that reads beyond index metadata (docs/mongo-user.md explains what).
    { resource: { cluster: true },
      actions: ["listDatabases", "serverStatus",
                "queryStatsRead", "queryStatsReadTransformed"] },
    { resource: { db: "", collection: "" }, // all non-system collections, all dbs
      actions: [
        "listCollections", "listIndexes",     // discover
        "indexStats", "collStats",            // usage + size + latency → ROI
        "createIndex", "dropIndex", "collMod" // act (collMod = hide before drop)
      ] },
    // The only find grants are metadata namespaces:
    { resource: { db: "", collection: "system.profile" }, actions: ["find"] },
    { resource: { db: "config", collection: "collections" }, actions: ["find"] }
  ],
  roles: []
})
```

Where direct role creation is not possible (Atlas manages users through its own
UI/API; the endpoint maps that failure to a 422 with guidance), create the same
role there manually and connect with the scoped string instead.

- `createIndex` builds the index under server authority, so **no read grant is
  needed** — the role never exposes document contents.
- **Confidentiality vs availability.** This role prevents data leakage, but
  `dropIndex` can still cause an outage and `createIndex` can spike load. The
  role does not replace the confirm / hide-first / windowed-build pipeline; both
  layers are required.
- **`system.profile` is the trust boundary.** Profiler entries contain query
  predicates with **literal data values**; that read powers workload analysis
  and partial-index detection and remains opt-in (`policy.workloadAnalysis`).
  The cleanup path (drop/merge) needs index metadata + `$indexStats` only →
  zero data exposure.

### 10.2 The control plane dials customer hosts — SSRF and the front door

Onboarding takes a connection string and connects to it. That makes the api a
request-forgery primitive unless two things are true.

**The target must not be ours.** `engine/net-guard.ts` resolves every host a
string would dial — including SRV expansion, because on Atlas the seed domain
is not what gets connected — and classifies each resulting address:

- **FORBIDDEN**, never dialed: link-local (`169.254.0.0/16`, which is the cloud
  metadata endpoint and never a database), multicast, reserved, unspecified,
  documentation and benchmarking ranges, IPv6 link-local.
- **PRIVATE**, dialed only when `ALLOW_PRIVATE_CLUSTER_TARGETS=true`: RFC1918,
  loopback, CGNAT, IPv6 ULA. Self-hosted installs need this; a hosted one must
  not set it.

IPv4-mapped IPv6 (`::ffff:10.0.0.5`) is unwrapped before classification — the
classic bypass. Every host in a multi-host string is checked, so a public host
cannot smuggle a private one alongside it. An unresolvable host is allowed
through to fail as "unreachable", which is honest and leaks nothing.

*Residual risk:* DNS may change between the check and the driver's own
resolution (rebinding). Closing it needs the driver to accept pre-resolved
addresses; the practical mitigations in place are the per-user dial budget and
the fact that a rebound target still has to speak the MongoDB wire protocol and
authenticate before anything is stored.

**The front door must not be open by default.** `SIGNUP_MODE` (`invite` by
default) gates account creation for both password and OAuth sign-ups via
better-auth's `user.create.before` hook: the first account bootstraps the
install, everyone after needs a pending invite for their address. `open` and
`closed` are the deliberate alternatives. This gates the *account* only —
joining an org still requires the invite token, so knowing an invited address
buys nothing.

Both are backed by a per-user budget (10 dials/minute, `errors/dial-budget.ts`)
that is consumed *before* the address check, so aiming at blocked addresses
does not buy free attempts.

### 10.3 Secrets at rest — app-level envelope encryption

MongoDB connection strings and agent tokens are encrypted with a swappable
`KeyProvider` (the master-key custodian). v1 keeps the master key in the runtime
environment (Docker secret / host env, never in git); it can later move to
self-hosted Vault/OpenBao or a cloud KMS with no call-site changes.

Primitive: **@noble/ciphers**, XChaCha20-Poly1305 with `managedNonce`
(24-byte random-safe nonce, auto-managed — avoids the GCM nonce-reuse footgun).
Pure TS, audited, zero deps, no native build, fully typed.

```ts
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { managedNonce, randomBytes } from "@noble/ciphers/utils.js";

// Master-key custodian. v1 = env; later Vault/KMS — same interface, swap impl.
interface KeyProvider {
  wrap(dek: Uint8Array): Promise<Uint8Array>;   // encrypt data key with master key
  unwrap(wrapped: Uint8Array): Promise<Uint8Array>;
}

// v1: master key = 32 random bytes, injected via env / Docker secret.
function envKeyProvider(masterKey: Uint8Array): KeyProvider {
  const kek = managedNonce(xchacha20poly1305)(masterKey);
  return {
    wrap: async (dek) => kek.encrypt(dek),
    unwrap: async (wrapped) => kek.decrypt(wrapped),
  };
}

interface Sealed { dek: Uint8Array; data: Uint8Array; }

// Envelope: random per-secret DEK encrypts data; KEK wraps the DEK.
async function seal(plaintext: Uint8Array, kp: KeyProvider): Promise<Sealed> {
  const dek = randomBytes(32);
  const cipher = managedNonce(xchacha20poly1305)(dek);
  return { dek: await kp.wrap(dek), data: cipher.encrypt(plaintext) };
}

async function open(s: Sealed, kp: KeyProvider): Promise<Uint8Array> {
  const dek = await kp.unwrap(s.dek);
  return managedNonce(xchacha20poly1305)(dek).decrypt(s.data);
}
```

`Sealed` is stored as two `bytea` columns (Drizzle `customType`).

**Accepted risk (v1).** With the master key in the app environment, an attacker who
obtains both the runtime env and the database can decrypt everything. A KMS/Vault
adds a separation boundary and an audit trail. For early stage with few customers
this is acceptable **provided** the master key is injected at runtime (never
committed), host access is tightly controlled, and a rotation path is planned.
Moving the custodian to Vault/OpenBao or a KMS is a funded-stage / first-enterprise
task, not a v1 blocker.

**Password hashing is separate.** better-auth owns credential hashing
(scrypt/argon2). Never hand-encrypt passwords with the above — it is only for
secrets at rest.

### 10.4 Rotating the master key

`clusters.key_version` records which key sealed each row, so rotation is a
rolling operation rather than a stop-the-world one — old rows keep opening while
new ones are written under the new key.

1. Generate a key and add it **alongside** the current one. Do not remove the
   old one yet; rows still sealed with it need it to open.
   ```
   MASTER_KEY=<old, still set>
   MASTER_KEY_V2=<new>
   MASTER_KEY_VERSION=2
   ```
   From here every new cluster is sealed at v2, and existing v1 rows still work.
2. Re-seal the backlog:
   ```
   node apps/api/dist/rotate-key.js
   ```
   It decrypts and re-encrypts inside the api process — plaintext never leaves
   it — one row at a time, each recording its new version. Safe to interrupt and
   safe to re-run; it reports `re-sealed N, failed M` and exits non-zero if
   anything failed.
3. Only once it reports zero remaining (re-run it; it will say "nothing to do")
   may the old key be removed from the environment.

A row that fails to re-seal almost always means the key that sealed it is gone.
The tool names each one rather than stopping, so one orphan does not block the
rest. It is also the only way back from an orphan: without its original key the
stored connection string is unrecoverable and the cluster must be reconnected.

### 9.3 Tenancy

Organizations → members → connected clusters. Every row is scoped by `orgId`;
all queries are org-filtered. An immutable audit log records every state transition.

---

## 11. Data model (PostgreSQL / Drizzle)

- **better-auth tables** (users, sessions, accounts) — via the better-auth Drizzle
  adapter.
- **organizations**, **members** — multi-tenant; everything scoped by `orgId`.
  `members.is_active` is the org switcher's selection (at most one per user;
  unset falls back to the oldest membership).
- **clusters** — connection mode, encrypted creds/agent token (`Sealed`),
  `demoMode` (default `true`).
- **agents** — registration, last-seen, version (phase 2).
- **index_snapshots** — time series: cluster / db / collection / index, spec,
  options, size, per-member ops, member uptime, `capturedAt`.
- **recommendations** — type, target, rationale, safety class, usage class,
  estimated savings, state.
- **actions** — audit: what / when / who-or-policy, before/after, rollback token,
  result.
- **roi_metrics** — freed bytes, throughput delta, index-count delta, per
  period. `recommendation_id` attributes each row to the drop that earned it
  (undo inserts a negative row against the same id, netting it out of the
  dashboard's per-index list).
- **policies** — per-cluster auto-apply rules, maintenance windows, thresholds,
  observe-window override.
- **audit_log** — immutable, every state transition.

### 11.1 Indexes on the control plane itself

An index optimizer is an embarrassing place to have nine un-indexed foreign
keys, which is what an audit of `pg_constraint` against `pg_index` found. An
un-indexed foreign key is not a slow query — it is a scan of the whole child
table for **every parent row deleted**. Retention bulk-deletes settled
recommendations and `roi_metrics` references them, so removing ten thousand rows
took 8.4 seconds, of which 5ms was finding them. With the index, 594ms.

`members` is the other one worth naming: it is the tenancy check on every
authenticated request, and it was a sequential scan. It is queried three ways —
by user, by org, and by both — so the composite leads with user and the org gets
its own, which is the same equality-ordering rule the engine applies to
everyone else's indexes.

The integration suite now **fails on any foreign key without a leading index**.
The nine are fixed; the point is that a tenth cannot be added quietly.

---

## 12. API & contracts

- **oRPC** contracts live in `packages/contracts` and are shared by api, web, and
  agent — one source of truth for types, no codegen, no `any`. Zod schemas validate
  at the boundary.
- **Dashboard API:** oRPC (`@Implement` on Nest controllers) over Fastify;
  consumed by the web app through the oRPC OpenAPILink client.
- **Agent channel (phase 2):** authenticated, outbound-initiated. The agent posts
  snapshots over HTTPS and receives commands (create/drop/hide) via a long-lived
  channel (long-poll or websocket). Agent authenticates with a per-agent token; mTLS
  is an option for higher tiers.

---

## 13. Background jobs

**graphile-worker** (Postgres-backed) — no Redis dependency, fits the compose setup.
Job kinds:

- **collect** — snapshot `$indexStats` / sizes per cluster on a schedule.
- **classify** — run `core` over recent snapshots to (re)generate recommendations.
- **execute** — run the apply pipeline steps (hide, drop, create) with pre-flight.
- **verify** — measure before/after and write `roi_metrics`.

In agent mode much of *collect* and *execute* runs agent-side on its own timer; the
control plane orchestrates and stores. graphile-worker can be swapped for
Redis + BullMQ only if scale demands it.

---

## 14. Web / dashboard (TanStack Start + Query + shadcn)

### 14.1 Routes

`/app` is a **layout** route, not a page. It owns what every signed-in view
needs and nothing about any one view: the auth gate, the "api is unreachable"
state, the cluster bar, the org switcher, sign out, and the nav.

| route | renders | loader |
|---|---|---|
| `/app` (layout) | shell + `<Outlet/>` | `shell` — clusters, org, orgs |
| `/app` (index) | ROI, recommendations, latency charts, per-collection footprint, policy | pipeline + telemetry + policy |
| `/app/org` | members, roles, invites, plan | none — reads the `shell` key |

It was one 452-line route that fetched ten things for every navigation, so
opening the team page pulled a latency series it never drew. Splitting it is
what makes `/app/org` cost three calls instead of ten.

Which cluster is on screen is **URL state**, not loader state. `/app` has no
`loaderDeps`, so selecting another cluster does not refetch the org or the
member list; the layout picks one out of the cluster list, and "none selected"
means the first.

### 14.2 Server state

**TanStack Query owns every read and every write.** Four keys, grouped by what
*changes* them rather than by what draws them:

| key | moves when |
|---|---|
| `shell` | a cluster is connected or disconnected, an org is renamed, a member changes |
| `pipeline` | every recommendation mutation — approve, undo, un-hide |
| `telemetry` | the collector runs, hours apart |
| `policy` | someone saves the policy form |

Approving a recommendation invalidates one key. `router.invalidate()` appears
nowhere in `apps/web/src`.

Route loaders remain the SSR entry point, but they **write through the router's
query client** (`context.queryClient.ensureQueryData`) rather than returning
data for the component to re-seed. One cache entry, not a server copy and a
browser copy that drift.

#### Things this cost three attempts to learn

All of these are load-bearing:

- **The cache must be dehydrated into the SSR payload.**
  `@tanstack/react-router-ssr-query` does it, wired in `getRouter()`. The router
  serializes loader *return values*, so a loader that fills the cache and
  returns nothing serializes nothing — the browser then hydrates against an
  empty cache, every `useQuery` starts at `undefined`, and every read the server
  just did is done again. Covered by the e2e test that blocks every `/api`
  call the *browser* could make before loading `/app` and expects the dashboard
  to draw — the SSR render is unaffected, because the web server dials the api
  off its own request rather than the page's.
- **`ensureQueryData` does not refetch stale data.** It resolves with cached
  data whenever there *is* any, stale or not, and fetches only when the entry is
  absent. So re-running a loader is not a refresh: `router.invalidate()` on the
  "api is unreachable" card produced *zero* requests, and the Retry button did
  nothing until a full page reload. Refetching the key is what retries.
- **A key must mean one thing forever.** `["policy", null]` meant *no cluster*
  before one existed and *cluster X* after, because `null` resolves to "the
  first cluster" server-side. One entry, two answers. The dashboard loader
  resolves the id against the `shell` first, by the same rule the cluster bar
  uses, so the two cannot disagree either.
- **A session change removes entries, it does not mark them stale.** Signing in,
  signing out and switching org replace *who is asking*, so `invalidateSession`
  refetches what is mounted — the reader keeps seeing something — and drops what
  is not. Marking an unmounted entry stale would not stop the next loader from
  rendering the previous org's recommendations.
- **`initialData` cannot seed a loader that re-runs** — it fills only an *empty*
  entry, so after connecting a cluster the cache keeps the pre-connect value.
- **The client is constructed exactly once**, in `getRouter()`, carried in route
  context, and read back out by the provider. A second `new QueryClient` in the
  root component gives the loaders one cache and the components another.
- **`useQuery`, not `useSuspenseQuery`.** Sign out and the org link *unmount*
  the dashboard, and a suspending child lets React hold the previous tree — a
  signed-out user kept looking at the signed-in dashboard.
- **`staleTime` is 30s**, and the reason is narrow: it is the only setting that
  decides whether mounting refetches, and mounting is what happens right after
  hydration. At `0` every page load re-fetched everything the server had just
  sent (measured: four browser calls per dashboard load, now zero). Half a
  minute is for changes *someone else* made; own mutations invalidate their key
  and refetch regardless. It stays under `gcTime`, or an inactive entry is
  collected while still counted fresh.

#### Where it lives

All of it is under `src/lib/queries`, which is the app's cache topology and
nothing else:

```
lib/queries/
  client.ts     createAppQueryClient + invalidateSession
  keys.ts       every key in the app
  shell.ts      shellQuery(), useShell(), selectCluster()
  pipeline.ts   telemetry.ts   policy.ts     one queryOptions factory each
  mutations/
    auth.ts   cluster.ts   org.ts   policy.ts   recommendations.ts
```

One factory per key, shared by the loader and the component that draws it. They
were inline in both places, so each key was written twice — and a key written
twice is two keys, one of which nothing ever fills.

#### Mutations

Every write is a `useMutation` whose invalidation fires only when the api says
something moved — a refused mode change has nothing to refetch, and a refused
disconnect must not deselect a cluster that is still connected. `isPending`
replaced the hand-rolled `busy` flags in the auth, connect and policy forms.

Each hook owns the key it invalidates. Components pass only the local state a
mutation cannot know about (a form to close, an error to show), which is why
`ClusterBar`, `TeamSection` and `PolicySection` have no callback props: a member
list should not have to know that leaving an org invalidates more than renaming
one.

### 14.3 Components

The UI is built from **shadcn/ui** components (`components.json`, new-york,
generated with the CLI into `src/components/ui`). Anything interactive comes
from there rather than raw elements: Button, Input, Label, Card, Select,
Checkbox, Separator, Alert, AlertDialog, Tooltip, Badge, Table, plus **sonner**
for toasts. `~` is aliased to `src` in both tsconfig and Vite so future
`shadcn add` output drops in unmodified.

Two deliberate deviations. The generated sonner wrapper is rewritten to drop
`next-themes` and its two `as` casts (the repo forbids assertions), and card
headings stay real `<h3>`/`<dt>` elements rather than `CardTitle` on the
landing page, because its heading outline is load-bearing for SEO.

Every destructive or cluster-affecting action goes through `ConfirmButton`
(AlertDialog) instead of `window.confirm`, so the dialog can show the exact
consequence — the revoke command for a disconnect, what a drop will observe
first, who loses access.

### 14.4 Landing page and SEO

`/` is the only indexable page: static (no loader, no api calls), so it renders
even when the control plane is down, and it carries the full meta set —
title/description, canonical, Open Graph and Twitter card, plus
`SoftwareApplication` and `FAQPage` JSON-LD emitted through the router's head
`scripts` (entries are spread as element props: `{type, children}`, not
`{attrs}`). The root route defaults to `noindex, nofollow` and the landing opts
back in, so the dashboard and the password-reset page can never be indexed —
new private routes inherit the safe default automatically. Canonical and
`og:url` come from a constant in `lib/site.ts`, overridable at runtime with
`SITE_URL`, so one image serves any domain and a preview host cannot make itself
the canonical copy. `robots.txt`, the OG card and the favicon are
static assets under `apps/web/public/`.

No `sitemap.xml`: with a single public URL it adds nothing a crawler cannot
find from `/`, and a static one cannot know the deployment's host. Add one (or
submit `/` directly) if the marketing site ever grows more pages.

### 14.5 Reaching the api

**The browser calls the api itself.** One oRPC client, `lib/api.ts`, used from
route loaders during SSR and from the query cache in the browser afterwards —
the same query function on both sides, so nothing has to know where it is
running. Three pieces differ, and each is a `createIsomorphicFn` the Start
compiler resolves per build environment:

| | browser | web server |
|---|---|---|
| base URL | `window.location.origin` + `/api` | `API_URL` + `/api`, read at runtime |
| session | its own first-party cookie, attached by a same-origin fetch | the caller's cookie, forwarded off `getRequest()` |
| fetch | plain | `instrumentedFetch`, imported *inside* the branch |

That last one is not fussiness. `lib/metrics` installs an OpenTelemetry provider
at import time (§15.1), so a top-level import would leave the SDK in the client
graph for tree-shaking to argue about; importing it inside the server branch
means the client build deletes the branch and the import with it. The built
bundle is checked for it.

**This replaced 28 `createServerFn` wrappers** across 13 call sites — 22 data
relays in `lib/app-server.ts` and 6 auth relays in `lib/auth.ts`, every one of
them a thin proxy from the web server to the api. The relay existed for one
reason: the api was on another origin, so a browser calling it directly would
have needed CORS with credentials and `SameSite=None` on the session cookie —
which is, by definition, a cookie that rides along on cross-site requests.
Putting both behind one origin removes the reason and the code.

What went with it:

- **`decodeOnce`.** The api percent-encodes the cookie value and `setCookie`
  encoded it again, so a base64 signature reached the browser double-escaped and
  every request after signing in was a 401 (issue #16, moot rather than done).
  The cookie the api sets is now the cookie the browser keeps.
- **The `{ ok, message }` envelope.** A server function had to catch the api's
  throw and hand back a value; the hook then unwrapped it. The oRPC client throws
  `ORPCError` in the same process as the mutation, so `onError` does that work
  and `lib/queries/errors.ts` holds the one rule it applies — which statuses
  carry a message written for the reader (`400/402/403/404/409`, plus the ones a
  given call adds) and which get a generic one, because a 500 must not leak
  internals.
- **One network hop per call**, and the second copy of every contract type.

Reads still catch rather than reject: a dead read renders an empty panel, not an
error page, so `shell`, `pipeline`, `telemetry` and `policy` each own the empty
shape they fall back to. The shell is the one that distinguishes 401 — signed
out — from everything else, which is "the api could not be asked".

Auth is `better-auth/react`'s own client (`lib/auth-client.ts`) with no
`baseURL`: it resolves one from `window.location.origin` and appends
`/api/auth`, which is where the api serves it. Writing an origin there would be
a second copy of the deployment's address to keep in step.

---

## 15. Deployment

- **Separate Dockerfiles** — `apps/api/Dockerfile` and `apps/web/Dockerfile`
  (multi-stage), so api and web deploy independently.
- **`apps/agent/Dockerfile`** — the distributable agent (phase 2).
- **docker-compose** (dev) — `postgres` + `api` + `web` + `proxy`, with **hot
  reload** via bind mounts and Turbo watch. PostgreSQL runs in compose. The
  nginx `proxy` owns port 3000 and applies the ingress's own rule (`/api` to the
  api, `/` to the dashboard), so local dev is not a second topology — see §14.5
  for why the app has no fallback if it is.

### 15.1 Metrics

OpenTelemetry instruments, exported to Prometheus on a **second port** — 9464 by
default, `METRICS_PORT`, opt-in via `METRICS_ENABLED`. All three workloads serve
their own `/metrics`; the chart adds a named port to the api and web Services, a
headless Service for the worker (its only one — nothing calls the worker), and an
optional ServiceMonitor for each.

A separate port rather than a route under `/api`, for the same reason §10 gives
for everything else: the ingress publishes the app hosts, the endpoint carries no
auth, and cluster counts, queue depth and pipeline state are operator
information. It is reachable in-cluster until someone deliberately exposes it,
which is also the shape a scrape target is expected to have.

The OpenTelemetry wiring is `packages/metrics` — one provider, one exporter, one
`startMetricsServer`. It is a factory rather than a module with an import-time
provider because **the caller has to own the moment the provider is installed**:
an instrument binds to whichever provider was global when it was created, so an
instrument built first is a no-op forever and gives no symptom. Each app has a
one-line module that calls the factory, and its instruments import the meter from
there, so module initialisation order does the rest. The instruments themselves
stay in the apps (`apps/api/src/metrics`, `apps/web/src/lib/metrics`), because
what to measure is not shared — only how to export it.

**The three workloads report disjoint sets**, because each can only answer for
what it sees:

| the api | the worker | the web server |
|---|---|---|
| HTTP requests and durations by route *pattern* — never the resolved URL, or one series per cluster id | job outcomes and durations off graphile-worker's own events (`success` / `retry` / `dead_letter`) | document render time per route pattern, and every response including the ones the api never hears about |
| Everything read from the control-plane database on collection: clusters, recommendations by state and type, queue depth per task, dead-letter backlog, age of the oldest unclaimed job | per-cluster tick outcomes, the unreachable-cluster count, regression-gate verdicts, drops executed | the api measured from the other end of the network (`status="unreachable"` when it never answered), which matters because the loaders swallow api failures into an empty panel |

With `RUN_WORKER=true` there is one process for the first two and it serves both
halves.

Three decisions inside that are not obvious:

- **The queue gauges are read from `graphile_worker.jobs`, not counted in the
  worker.** Counters in the worker reset when it restarts and report nothing at
  all when there is no worker running — which is the state most worth alerting
  on. A job's state is a function of its columns (`attempts >= max_attempts` is
  the dead letter, `locked_at` is running), so it is one grouped query.
- **Observable instruments for anything that describes state.** A label set that
  stops existing — the last cluster of an engine disconnected, a task drained —
  stops being reported, instead of freezing at its final value the way a gauge
  written as things change would.
- **The unreachable-cluster count lives in the worker's memory.** Sound for the
  same reason the alert cooldown is (§13, one replica by design), and it is the
  only place the answer exists: an unreachable cluster is a *handled* condition
  (§7.4.1), so the tick succeeds and no queue counter ever sees it. The
  dispatcher passes the current fleet on every fan-out, so a cluster offboarded
  while unreachable is forgotten rather than counted forever.

On the web side, two more:

- **One seam, `src/server.ts`** — a server entry vite builds for the SSR
  environment alone. It starts the listener at boot and counts every response; a
  listener started lazily on the first request would have Prometheus report the
  target as down until someone visited the site. Being server-only by
  construction is the other half of why it is the seam: **the browser bundle must
  not contain the OpenTelemetry SDK**, so nothing under
  `apps/web/src/lib/metrics` may be imported from a route or a component.
- **There is no per-server-function instrument** (D29), and since D31 there are
  no server functions either. The decision outlived its subject: a seam that only
  restates the instrument next to it is not worth its framework wiring. What D31
  did change is the *scope* of the two that remain —
  `indexterity_web_api_requests_total` is SSR reads only now, because a reader's
  own calls no longer pass through this process, and `kind="server_fn"` is gone
  from the request counter for the same reason. A series that is always zero
  reads as "no traffic" rather than "no such thing".

Route labels are the route *pattern*, derived from the generated route tree
(`apps/web/src/lib/metrics/routes.ts`) rather than the path that arrived: a
counter labelled with arbitrary URLs grows a series per scanner request. The
walk reads properties off route objects, so a test asserts it against the real
tree — otherwise a framework change would make every request `unmatched` and
nothing would say so.

Instrumentation is the vendor-neutral API, so exporting to an OTLP collector
instead of a scrape endpoint is a change to `packages/metrics` alone. Pod CPU and
memory come from the platform; nothing here duplicates them.

### 15.2 Alerts

The chart ships them (`metrics.prometheusRule`, off by default like the
ServiceMonitor since both need the Operator CRDs), grouped by the question they
answer: is the schedule running, is work piling up, can we still reach the
clusters, is the safety pipeline meaningful, is the control plane healthy, what are
readers seeing. Thresholds are values; the stale-schedule windows are the crontab
in `jobs/runner.ts` plus room for one missed tick, so the two have to move
together.

Three of them are the reason this is in the chart rather than left to whoever
deploys it, because the obvious rule is wrong:

- **`increase()` cannot see a dead process.** When the worker stops, its series go
  stale — and a stale series matches no `== 0` comparison, so the intuitive
  "no successes in 30 minutes" rule is silent in precisely the worst case.
  `absent_over_time(indexterity_clusters_unreachable[10m])` is what fires, keyed on
  a gauge only the process running the pipeline ever reports.
- **Alert on the `schedule*` dispatchers, not the per-cluster tasks.**
  `scheduleCollect` ticks on cron unconditionally; `collect` only runs if a cluster
  exists, so a rule watching it pages the moment the last one is offboarded.
- **`IndexterityControlPlaneDatabaseUnreachable` covers a gap in the probes.**
  `/api/health` returns `ok` without touching Postgres, so neither liveness nor
  readiness notices a lost database. A rising
  `indexterity_metrics_scrape_errors_total` does, and it fires with no traffic at
  all — which is when nobody would otherwise find out.

A rule with a typo installs cleanly and then never fires, which `helm lint` and
`kubeconform` both accept, so CI renders the chart and runs `promtool check rules`
over it.

---

## 16. Engineering standards

- No `any`, no `as` overrides, no linter-ignore comments. Strict TypeScript
  everywhere; the contracts package enforces boundary types.
- Every dependency pinned to latest stable at scaffold time.
- Comments stay short.
- **Clean runtime.** The api and the web app must run with no errors and no
  warnings — server logs, build output, and the browser console. A warning is a
  defect: fix the cause, never silence it. In particular:
  - Nothing may log above `info` on a healthy request. An expected external
    condition (a cluster that is down, a customer's credentials we cannot
    decrypt) is *handled* — classified, logged once at the right level, and
    turned into a decision — not thrown as a stack trace and retried.
  - The web app hydrates without mismatches. Anything the server cannot compute
    the way the reader will see it — their clock, their timezone — is gated
    behind `useMounted()` (`apps/web/src/lib/hydration.ts`) so both sides of
    hydration render identical markup.
  - Builds emit no warnings; a framework asking for a config value (nitro's
    `compatibilityDate`) gets one.
- **graphify** — once the monorepo exists, build the knowledge graph and treat
  architecture / flow / dependency questions as graph queries first. Re-run when a
  large change may have made the graph stale.

---

## 17. Decision log

| # | Decision | Rationale | Status |
|---|----------|-----------|--------|
| D1 | Control-plane / data-plane split | Keep prod creds and DB access isolated from the SaaS; enables agent mode later | Locked |
| D2 | Hosted-direct connection for v1 | Fastest onboarding / self-serve; agent is an additive impl, not a rewrite | Locked |
| D3 | Index-only MongoDB role | No data-row exposure in cleanup path; strong trust story | Locked |
| D4 | Hide → observe → drop pipeline | Makes drops reversible until the final confirmed step | Locked |
| D5 | Observe window 30d, adaptive + pattern-aware + configurable | Catches monthly jobs; waiting only delays benefit, dropping early causes outages | Locked |
| D6 | Usage classified by time series (incl. `PERIODIC_DEAD`) | Distinguishes live periodic jobs from decommissioned ones — safer and faster | Locked |
| D7 | "Instant apply" limited to creates, opt-in, size-gated | Auto-create is additive-ish; auto-drop never instant | Locked |
| D8 | App-level envelope encryption via swappable `KeyProvider`, `@noble/ciphers` | Zero cost, no extra infra, no lock-in; KMS/Vault later without call-site changes | Locked |
| D9 | **oRPC** for contracts (was ts-rest) | Migrated Jul 2026 at the founder's call: same contract-first shape (`@Implement` mirrors `@TsRestHandler`), zod 4 native, OpenAPI-standard paths kept so the integration suite survived unchanged (11/12 on first run). Handler errors are ORPCError-coded; the Nest filter now covers only non-oRPC paths | Revised |
| D10 | graphile-worker for jobs | Postgres-backed, no Redis; fits compose | Locked |
| D11 | Demo/read-only default per cluster | Read-only is structural, not a toggle | Locked |
| D12 | npm workspaces (not pnpm) for now | Local Node is Zed-managed; a global pnpm install conflicted. Turbo supports npm workspaces; swappable later | Locked |
| D13 | TypeScript **6** (last JS line); api built with **swc** directly (no Nest CLI) | Was TS 7 (native), but 7 ships no `tsserver.js` until 7.1 — editors broke. TS 6 keeps full toolchain parity (tsserver, programmatic API); typecheck speed is a non-issue at this repo size. Revisit 7 at 7.1 | Revised |
| D14 | **zod 4** (pin lifted) | Landed with the oRPC migration (D9). The api's internal driver-boundary schemas were already v4-compatible (two-arg `z.record`, no deprecated APIs) — zero code changes beyond `z.uuid()`/`z.email()` in the contracts | Revised |
| D15 | **Provisioned least-privilege onboarding** instead of an Atlas API integration | Jul 2026. An admin string is used once to create the `indexterityEngine` role + an `idx_<hex>` user on the customer's cluster; only the scoped string is stored (the admin one never persists). Turns "we can't read your documents" from a promise into a server-enforced guarantee (§10.1), works on any self-hosted/community deployment, and degrades to a guided 422 on Atlas (which owns its user management). Live-verified under `--auth`: full engine surface allowed, find/insert/drop/escalation denied, collect e2e as the scoped user | Locked |
| D19 | **"Cannot tell" is never spelled "all clear"** | Jul 2026. Losing a cluster for days or weeks used to end badly: `$collStats`/`$indexStats` counters are cumulative since mongod started, so a restart during the observe window made `current − baseline` negative, which failed the minimum-ops check and read as *no regression* — the drop then proceeded on evidence that no longer existed, with the pre-flight's `$indexStats` check equally reset. The gate now returns REGRESSED / STABLE / **UNOBSERVABLE**; an unobservable window un-hides and re-proposes (which also ends the case of an index left hidden through an outage), and the create-side watch re-baselines instead of graduating unchecked. Separately, usage findings now require a continuous, current history (≥ 3 snapshots, no hole over 48h) — during a gap a busy index is indistinguishable from a dead one — and repeat failure alerts are capped at one per cluster+task per day | Locked |
| D23 | **The observe window scales to the index's age, not just its usage** | Jul 2026. The window already stretched for periodic usage and shrank for long-proven idleness, but both keyed on the history's *span*, which conflated two different things: how long we have watched, and how long the index has existed. A hand-made ad-hoc index — created, used once by whoever made it, forgotten — has a short span, so it got the full flat month before removal, the slowest possible treatment for the clearest possible case. Two rules added: an index that appeared while we were watching and has never been used is observed roughly as long as it has existed (≥ 7d, ≤ policy), since its entire life is on record and there is no hidden history to wait out; and an index in place ≥ 2× the policy window that saw real use gets 1.5× the policy, because whatever wanted it may want it again on a cadence longer than anything recorded. Age is only claimed when the index first appears at least a day after the cluster's earliest snapshot — collection starts at onboarding, so otherwise every index on a new cluster would look newborn and get fast-tracked, which is the warmup hazard rather than a fix for it | Locked |
| D24 | Api served under `/api`, on the dashboard's origin | The cookie is the whole argument: two origins means CORS plus `SameSite=None`, which by definition attaches the session cookie to cross-site requests. One host with `/api` and `/` path rules makes it first-party instead. Required `setGlobalPrefix("api")` first — better-auth sits on Fastify at `/api/auth`, controllers sat at bare paths, and no single proxy rule covered both | Locked |
| D25 | Server state through TanStack Query, keyed by what changes it | Started as three keys — pipeline, telemetry, policy — rather than one blob, so approving a recommendation stops refetching the latency series. Loaders write through the router's query client instead of returning data to re-seed: one cache entry, not two that drift. Extended Aug 2026 to the whole app: a fourth key, `shell`, and every mutation a `useMutation` with a targeted invalidation, so `router.invalidate()` exists nowhere in `apps/web/src`. Three corrections came out of finishing it, all in §14.2. The cache was never reaching the browser — the router serializes loader *return values*, and a loader that fills the cache returns nothing, so every read the server did was done again on hydration (`@tanstack/react-router-ssr-query` fixes it). `ensureQueryData` does **not** refetch stale data, only absent data, which made the "api is unreachable" Retry button measurably inert and means a session change has to *remove* the previous session's entries rather than mark them stale. And a key resolved from "the first cluster" meant two different clusters at two different times, which only a zero `staleTime` was hiding | Revised |
| D26 | `minCount` is a floor **and** a rate | Three sightings meant two different things: `$queryStats` accumulates for the life of the store, the profiler is a ring a busy collection fills in minutes. Both windows turn out to be measurable — `firstSeenTimestamp` and the oldest `ts` — so both are measured. Fortnightly admits a weekly report and rejects a handful of runs since March | Locked |
| D22 | **One auto-approval control, not two** | Jul 2026. `autoApply` (boolean) and `autoApplyScore` (threshold) read like a switch and its dial but were mutually exclusive branches, and the boolean won: setting both silently discarded the number the owner had typed directly beneath the checkbox. The boolean also promoted `ADVISORY_REVIEW` rows, which the score path explicitly excluded — and an approved advisory is worse than useless, because `classify` only deletes and re-inserts PROPOSED rows, so it leaves the refresh pool and is never re-evaluated even after the index starts being used again. `autoApply` is deleted: `autoApplyScore` alone means null = a human approves everything, 0 = everything auto-approves, 1-100 = a confidence floor, advisories never at any setting. Strictly more expressive than the pair, and both bugs stop existing rather than being fixed. Migration carries `auto_apply = true` across as threshold 0 — the behaviour that was actually running | Locked |
| D21 | **The change window picks itself when unset** | Jul 2026. An unset window used to mean "run elective changes at any hour", which is the worst default available: the one moment a drop's brief collection lock is least welcome is peak traffic, and the owners least likely to configure a window are the ones least able to absorb that. The engine now derives one from the cluster's own `latency_samples` — cumulative counters differenced, bucketed into the four 6h slots of the UTC day, quietest slot wins — and re-derives it after every collect so it tracks a workload that moves. Six hours is the honest resolution: collect runs every 6h, so claiming an hour-level window would be precision the evidence does not have. It refuses to guess rather than guessing badly: three clean observations per bucket minimum, the quiet slot must be ≤ 75% of peak (a flat day yields nothing), and intervals crossing a counter reset or a collection gap are discarded. Stored in `inferred_window_*`, apart from the owner's columns, so an explicit setting always wins and clearing it returns to auto instead of freezing the last guess | Locked |
| D20 | **A warning is a defect** (§16) | Jul 2026. Adopted as a repo rule, then applied. Three real faults were hiding behind "just warnings": every oRPC route logged `FST_ERR_REP_ALREADY_SENT` because `@orpc/nest`'s interceptor sends the Fastify reply itself while Nest — which only stands down when a handler declares `@Res()` — sent a second empty one (fixed by wrapping `@Implement` in `src/orpc/implement.ts`, so no route can forget); an unreachable cluster threw five stack traces per task per tick instead of being classified and skipped; and the dashboard rendered `toLocaleString()` during SSR, guaranteeing a hydration mismatch for every reader outside UTC. Each was a genuine behavior bug whose only symptom was log noise | Locked |
| D18 | **Deny-by-default network guard + invite-only sign-up** (§10.2) | Jul 2026. Onboarding dials whatever an owner pastes, which made the api a request-forgery primitive: with open sign-up, anyone could register and use it to map our internal network, or connect an unauthenticated internal database outright. Targets are now resolved (SRV expanded, IPv4-mapped IPv6 unwrapped, every host in a multi-host string checked) and classified — link-local/metadata forbidden outright, private ranges only with `ALLOW_PRIVATE_CLUSTER_TARGETS`; sign-up defaults to invite-only with first-user bootstrap; a per-user dial budget is consumed before the address check. Self-hosted installs flip both knobs, and the chart warns when the combination is unsafe | Locked |
| D16 | **Engine ports** extracted for future PostgreSQL/SQL Server support (§9) | Jul 2026. `IndexCollector`/`IndexExecutor`/`EngineSession` moved to `src/engine/ports.ts`; adapters register per `clusters.engine` (enum ready, MONGODB the only implementation); the pool, jobs, and API speak only the ports. Capability flags (`hideIndexes`, `provisionScopedUsers`) mark where engines genuinely differ — notably PostgreSQL has no reversible hide, so its adapter will need an alternative observe stage. Behavior-preserving: the untouched integration suite (25/25) passed on the refactor | Locked |
| D17 | **Dynamic observe window** + recurrence floor | Jul 2026. The observe window is decided per drop at hide time from the index's own usage history (`analysis/observe.ts`, stored in `recommendations.observe_days`, reason in the audit trail): periodic usage extends to 2× the largest activity gap (≤ 90d) so a monthly job gets a full cycle inside the window; zero usage across ≥ 2× the baseline shortens to half (≥ 7d). Policy stays the baseline and the fallback. Workload shapes now need ≥ 3 sightings to propose and ≥ 5 for instant apply — a manually-run heavy query once or twice produces nothing | Locked |
| D27 | Internal packages compile to CJS `dist`; apps consume built output | Predictable dev/prod module resolution; Turbo orders builds via `^build` | Locked |
| D31 | **The browser calls the api directly; the web server is not a BFF** (§14.5) | Aug 2026. 28 `createServerFn` wrappers existed for one reason — two origins, so a direct call would need CORS with credentials and a `SameSite=None` session cookie. #28 put the api under `/api` on the dashboard's host, which removes the reason, so the wrappers, `decodeOnce` (#16, moot) and one hop per call all go. The alternative was keeping the relay as a documented fallback for split-origin installs, and that was **rejected**: supporting both means maintaining both, and the fallback is the path nothing exercises. So same-origin is a requirement, and every way of running the app applies the same rule — ingress, an nginx service in compose, the vite dev proxy, a node proxy in front of the e2e suite. Two costs, both accepted: the api is publicly reachable, so its rate limiting, origin checks and auth guard are the only line of defence rather than the second (#21 in the same breath); and a self-hoster on two ports has to put a proxy in front. It also unblocks #22 — SSE from the browser straight to the api is materially simpler than streaming through a relay | Locked |
| D30 | **The chart ships the alerts, not just the metrics** (§15.2) | Aug 2026. Three scrape endpoints and a blank Prometheus is not observability — it leaves every operator to derive the same queries from metric names they have to discover first, and two of those queries are ones a careful person still gets wrong. `increase()` cannot see a dead process: a stopped worker's series go stale, and a stale series matches no `== 0` comparison, so the intuitive "no successes recently" rule is silent in the one case that matters (`absent_over_time` on a gauge only that process reports is what fires). And the schedule lives in the `schedule*` dispatchers, not the per-cluster tasks — `collect` legitimately stops when the last cluster is offboarded, so a rule watching it pages on a successful offboarding. Also folded in: the api's health endpoint answers `ok` without touching Postgres, so a lost database is invisible to both probes and needs an alert of its own. Rules are validated in CI with `promtool`, because a typo'd expression passes `helm lint` and `kubeconform`, installs cleanly, and then never fires | Locked |
| D29 | **The dashboard server reports three things, and per-function metrics are not one of them** (§15.1) | Aug 2026. D28 covered the api and the worker, which left the layer the reader waits on unmeasured. Most of what the dashboard does is already visible from the api's side — every server function call lands there — so the question was which of the remainder is worth a seam. Three are: render time per route pattern, a response the api never heard about (a loader that threw, a 404), and the api measured from this end of the network, which is the only place a *partial* api failure is recorded at all, because the loaders catch everything and render `EMPTY_PIPELINE` rather than an error. One seam serves all three: `src/server.ts`, SSR-only by construction, which also keeps the SDK out of the browser bundle. Per-function metrics were built, worked, and were **removed**: a server function here is one to three api calls and almost no work of its own, so its duration is those calls plus noise, and naming it cost a second framework seam (global *function* middleware — request middleware cannot see a direct SSR invocation — plus an SSR-guarded import in `src/start.ts`). The instrument that restates another one is the one to cut. Extracting `packages/metrics` came first regardless, so the exporter stays one decision rather than three | Locked |
| D28 | **Metrics on a second port, instrumented through OpenTelemetry** (§15.1) | Aug 2026. There were none: a service that hides and drops indexes on other people's production clusters could not state how many clusters it currently cannot reach, how long its queue is, how many drops are mid-observe, how often the regression gate fires, or what its dead-letter rate is. OpenTelemetry rather than a Prometheus client library so the exporter is a decision in one file — the chart ships a ServiceMonitor today, and an install that wants an OTLP collector should not need a rewrite. A second port rather than a route under `/api` because the endpoint has no auth and the ingress publishes the api host. Two things fell out of writing it: queue depth belongs in SQL over `graphile_worker.jobs`, not in worker-held counters that vanish on restart and report zero when the worker is *gone*; and the unreachable count has no source other than the worker's own memory, because an unreachable cluster is a handled condition (§7.4.1) that the queue records as a success | Locked |

### Deferred / open

- **KMS/Vault custodian** — deferred to funded stage / first enterprise deal
  (see §10.3). App-level now.
- **TypeScript 7 (native)** — re-adopt at 7.1 when `tsserver.js` and the
  programmatic compiler API return; also unblocks reverting api to the Nest CLI
  (see D13).

- **`@thallesp/nestjs-better-auth`** — evaluated Aug 2026 (#29), **not adopted**.
  It is what better-auth's own NestJS page recommends, but that page is pointing
  at a community package rather than a first-party integration, and it says the
  library has "beta support for Fastify" — which is the adapter we run. Its
  setup instruction (`NestFactory.create(AppModule, { bodyParser: false })`) is
  Express-shaped and not what the Fastify path does; that path removes and
  re-registers Fastify's content-type parsers instead.

  The reason for the "no" is measured. On Fastify the module serves better-auth
  through middie middleware instead of a Fastify route, and `@fastify/rate-limit`
  only sees routes — so `AUTH_RATE_LIMIT_MAX`, a documented operator knob set in
  `.env.example`, the chart and both test harnesses, **silently stops doing
  anything**. Our own integration test fails, correctly.

  The first measurement said worse than that — 0 of 25 sign-in attempts throttled
  — and it was wrong, because the spike ran without `NODE_ENV=production`.
  better-auth enables its own limiter only in production, and with it set the
  same probe throttles 22 of 25 at better-auth's default 3-per-10s for sensitive
  endpoints. So adopting would not leave auth unprotected: it would *replace* our
  bucket with a tighter one we do not control from the environment. Worth knowing
  on its own account — the production image sets `NODE_ENV=production`, so
  better-auth's limiter is already running alongside Fastify's today.
  The body-parser interaction that looked like the risk turned out not to be
  one: 59 of 60 integration tests passed, so its Fastify JSON parser handles
  oRPC bodies. The prize was smaller than it looked, too — the module replaces
  the 34-line mount in `main.ts`, `auth/http.ts` and `auth/session.ts`, about 57
  lines. `auth.config.ts` is the `betterAuth()` call it takes as *input*, and
  `tenancy.ts`, `signup-gate.ts` and `cookies.ts` are ours. Revisit if we ever
  adopt better-auth's organization plugin: `@Roles()`, `@OrgRoles()` and
  `@RequireActiveOrg()` are unusable while orgs live in our own `members` table,
  and they are most of what the package offers beyond the mount.
- **`nestjs-trpc`** — considered Aug 2026, **staying on `@orpc/nest`**. tRPC infers
  the client's types from the server's implementation, which would replace
  `packages/contracts` — a shared artifact both sides are checked against — with
  a dependency on the api's internals. It would also cost the REST surface: the
  contract carries real routes and generates the OpenAPI document that
  `ingress.api.*` exists to expose, and `/trpc/listClusters?input=…` is not an
  api anyone wants to consume. No pain reported with oRPC, and subscriptions are
  not the deciding factor either — the passthrough already streams (§14.5), so
  #22 does not need a different RPC layer.
- **Agent mode** — phase 2. Interface designed for it from day one.
- **Suggest-mode (`CREATE` from workload)** — higher trust tier; needs profiler
  access. Ship cleanup path first.

---

## 18. Phasing

The original phasing is complete through the engine, the apply pipeline, ROI,
multi-tenancy, billing, the Helm chart and v0.1.0.

Planned work now lives on the
[project board](https://github.com/users/FullmetalBober/projects/6). It is not
duplicated here — two roadmaps in one repo is one roadmap and one lie. This
document records what was decided and why (§17); the board records what is
next.
