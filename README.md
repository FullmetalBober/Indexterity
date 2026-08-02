# Indexterity

Index dexterity for MongoDB. A SaaS that watches your indexes and manages them
safely — drop the unused and redundant, merge overlapping, extend prefixes,
create the missing — and proves the result in freed bytes and latency.

Read-only by default. The one irreversible step, a drop, is gated behind an
observe window, a pre-flight check, and a read-latency regression test.

Full design and decision log: [`docs/architecture.md`](./docs/architecture.md).

## How it works

1. **Connect** a cluster with any connection string. Indexterity first reports
   what that string can actually do — nothing stored, nothing written. If it can
   create users, it *asks* before provisioning its own least-privilege user
   (`idx_<hex>`, no `find` on your collections, so it **cannot read documents**).
   The admin string is used once and never persisted; only the scoped one is
   stored, sealed with envelope encryption.
2. **Collect** every 6h via `$indexStats` / `$collStats` — usage, sizes,
   per-collection read/write latency. Never your documents.
3. **Decide** with a pure analysis engine (`apps/api/src/analysis` — no I/O, so
   it is unit-tested without a database or a cluster).
4. **Apply** safely: `hide → observe → drop` for removals, `build` for
   additions. Clusters start read-only; an owner flips them live.
5. **Prove ROI**: freed bytes and the $/month they cost, index-count delta, and
   a before/after latency trend per collection.

## What it decides

**Dropping.** Each index gets a usage class from its op-count history
(`FLAT_ZERO`, `CONTINUOUS`, `PERIODIC_ALIVE`, `PERIODIC_DEAD`). Dead usage or
redundancy earns a proposal.

A usage claim needs a history worth trusting: **at least a week of it, and at
least three days in which the collection was actually queried**, with no hole
over 48h, a recent newest snapshot and no counter restart. The week is the
warm-up; the activity requirement is what makes it mean something. An index
reads zero either because nobody needs it or because nobody touched the
collection — elapsed time cannot tell those apart, so an always-on but idle dev
cluster would otherwise accumulate a month of "proof" without doing any work.
Intervals in which the collection served no reads simply do not count.
Redundancy is structural and unaffected.

**Never dropped**, whatever the usage: `_id_`, unique (including unique partial
and sparse — a constraint is not a performance hint), TTL, and shard-key
indexes. They surface as advisories instead. Partial and sparse indexes without
a constraint *are* droppable: the pipeline hides and measures rather than
trusting the counter.

**Adding** (opt-in via `workloadAnalysis`). Query shapes come from `$queryStats`
on **mongo 8.0+**, and from the profiler below it. `$queryStats` exists from 6.0,
but until 8.0 it reports execution counts only — no `docsExamined`, no
`keysExamined`, no `hasSortStage` (verified against live 6.0, 7.0 and 8.2
servers). That is the difference between knowing a query ran and knowing it
scanned, so on 6.0 and 7.0 the profiler is the only source that can suggest an
index and the engine falls back to it. Either way `$queryStats` records nothing
until `internalQueryStatsRateLimit` is set — it is `0` by default, and connecting
a cluster says so if it is.

Two shapes earn an index. One is a **collection scan**. The other is a query
that finds its documents through an index and then **sorts them in memory** —
invisible to every scan test, because keys were examined, and the failure mode
that ends in an error rather than slowness, since a blocking sort dies at 100 MB.
The fix is usually extending the index that already found the documents so it
can order them too.

A shape must recur — **3+ sightings** — and must come from something other than a
person at a prompt. `$queryStats` groups by client and the profiler records
`appName`, so the same query from `mongosh` and from your app arrive as separate
entries; one seen only from shells and GUIs earns nothing, because the index
would be maintained on every write for years for queries nobody runs again. Keys
are ordered Equality → Sort → Range. An equality field compared against the same
literal every time moves into a `partialFilterExpression` instead of the keys:
smaller index, same query.

## The safety pipeline

```mermaid
stateDiagram-v2
    [*] --> PROPOSED: engine proposes, scored 0 to 100
    PROPOSED --> APPROVED: dashboard, or score at least autoApplyScore
    APPROVED --> HIDDEN: drop path — pre-flight, then hide
    HIDDEN --> REJECTED: reads regressed — un-hidden + cooldown
    HIDDEN --> PROPOSED: pre-flight failed — un-hidden, re-proposed
    HIDDEN --> DROPPED: observe window elapsed, all gates passed
    DROPPED --> ROLLED_BACK: undo — rebuilt from the rollback token
    APPROVED --> ACTIVE: create path — build
    ACTIVE --> ROLLED_BACK: writes regressed — dropped + cooldown
    ACTIVE --> [*]: survives the watch window — graduates
```

Hiding (`collMod hidden:true`) is instant and reversible, and starts the observe
window. Before the drop, `finalize` gates it three ways:

- **Observability.** `$collStats` counters reset when mongod restarts, so a
  restart mid-window leaves a baseline that means nothing. That reads as
  UNOBSERVABLE, never as "no regression" — the index is un-hidden and
  re-proposed rather than dropped on evidence that no longer exists.
- **Regression.** Read latency above `baseline × 1.5` un-hides the index and
  parks it in a cooldown that escalates on repeats, so it is not re-proposed
  and re-cycled.
- **Pre-flight.** Index now protected, covering index gone, or fresh ops on it
  → un-hide and re-propose.

Additions get the mirror treatment: write latency is baselined at build time,
and an index that slows writes during its watch is dropped and cooled down. One
that survives graduates.

Every executed operation writes an immutable `actions` row.

Two escape hatches on the dashboard. **Keep it** cancels a pending drop while
the index is still hidden: it becomes visible again immediately and is parked
for 90 days so the engine does not re-propose it. **Undo** rebuilds a dropped
index from the spec captured at drop time and corrects the ROI headline back
down. Neither counts as a regression — that number feeds the score, and nothing
regressed.

**The score.** Every recommendation carries 0–100, and the scale is calibrated
so 100 is reachable and means "as sure as this engine gets". Drops: the argument
is worth 55 (redundant), 50 (never used) or 35 (was periodic, went quiet); a
month of unbroken history adds up to 25; reclaimable space up to 20. Creates: 40
for a live collection scan, up to 35 for frequency, up to 25 for collection size.
Each past regression on the same index subtracts 40, so one is nearly
disqualifying and two are. The score gates *entry* only — every safety stage runs
regardless.

## Policy knobs (per cluster)

| knob | effect | default |
|------|--------|---------|
| `readOnly` | compute everything, never write | on |
| `workloadAnalysis` | enable the create/merge/update engine | off |
| `instantCreate` | build critical missing indexes without approval | off |
| `observeWindowDays` | baseline bake time for a hidden index; scaled per index (below) | 30 |
| `maxCollectionSizeBytes` | size ceiling for building new indexes | — |
| `autoApplyScore` | the one auto-approval control: empty = you approve everything, `0` = everything auto-approves, `1`–`100` = a confidence floor. **70 is the suggested setting.** Advisories never auto-approve | empty |
| `changeWindowStartHour` / `EndHour` | elective changes run only in this UTC window; safety rollbacks never wait | engine-chosen |

**The observe window scales to the index.** `observeWindowDays` is the baseline;
each pending drop gets its own, decided once at hide time and recorded with its
reason:

| the index | window |
|-----------|--------|
| periodic usage (monthly report, weekly batch) | 2× the largest activity gap, ≤ 90d |
| in place ≥ 2× the policy and used in that time | 1.5× the policy, ≤ 90d |
| zero usage across ≥ 2× the policy | half the policy, ≥ 7d |
| appeared on our watch, never used since | about as long as it has existed, ≥ 7d |
| anything else | the policy |

The last two handle a hand-made ad-hoc index: created, used once, forgotten. Its
whole life is on record, so it leaves in about a week instead of a month. Age
only counts when the index appeared *after* we started watching — snapshots
begin at onboarding, so an index in the first one may be five years old.

**Every five minutes, a health probe.** Two things, in order.

First the server as a whole. CPU is not available — mongod reports none outside
FTDC — but `serverStatus` reports what the query engine is *doing*: collection
scans, documents and index keys walked, sorts run with no index to order by, and
operations queued behind the global lock. The signal is **documents walked per
index key**, which is volume-independent, so it reads the same on a small
cluster and a large one. A loaded CPU could be a backup or a noisy neighbour;
thousands of documents per key is a missing index and nothing else. This catches
a scan storm spread thinly across many collections that no single collection's
latency would show.

Then per collection: a missing index shows up as average read latency climbing
while the collection keeps serving traffic. When reads get sharply slower than
their own baseline, the workload pass runs immediately instead of waiting for the
hourly one. Only the busiest 20 collections are probed, and the readings are
never written to `latency_samples` — that table's 6h cadence is what the activity
gate and the change-window inference count intervals in.

`serverStatus` is the one privilege that reads beyond index metadata, so it is
optional: a cluster without it onboards clean and simply loses the first half of
the probe. [`docs/mongo-user.md`](./docs/mongo-user.md) says exactly what it
exposes.

**The change window picks itself.** Left unset, the engine buckets the cluster's
own traffic into the four 6h slots of the UTC day and takes the quietest,
re-deriving after every collect. It declines to guess on a flat day or thin
history, and an explicit setting always wins.

## Connecting a cluster

**MongoDB 6.0 to 8.x.** 4.4 and 5.0 are past end-of-life and have no
`$queryStats`, so they are refused rather than supported half-well. A server
below the floor is refused at connect time with that explanation, and every
write re-checks the version immediately before running, so a cluster downgraded
or repointed later cannot be half-changed. A major series newer than anything
tested is refused too — this engine drops and builds indexes on a live database,
and a major release is where command behaviour moves. Set
`ALLOW_UNTESTED_MONGO_VERSION=true` to run ahead of the tested range.

See [`docs/mongo-user.md`](./docs/mongo-user.md) for the exact `createRole`
snippets. Indexterity never gets document read or write privileges.

**Replica sets** — `$indexStats` is per member; usage sums all of them, so an
index used only on a secondary counts as used.

**Sharded clusters** — point at the `mongos`. Stats aggregate across shards, and
each collection's shard key is read from `config.collections` so any index it
prefixes is protected. Without config read, the collection is treated as
unsharded.

## Auth & tenancy

Every endpoint requires a better-auth session and is scoped to the caller's org.
The dashboard is a BFF: it proxies `/api/auth` to the api so the cookie lives on
the web origin, then forwards it on every data call. Set `WEB_ORIGIN` (api) and
`VITE_WEB_ORIGIN` (web) to the dashboard's public origin.

Org creators are **owners**, invited users are **members**. Members read
everything; every mutation is owner-only. Invites are one-time tokens with a
7-day expiry, emailed when `SMTP_*` is configured and a logged no-op otherwise.

## Stack

Turbo monorepo · NestJS + Fastify (api) · TanStack Start + shadcn (web) ·
better-auth · Drizzle + PostgreSQL · oRPC contracts (zod 4) · graphile-worker ·
Biome · strict TypeScript (no `any`, no `as`, no lint-ignore).

```
apps/api                control plane
  src/analysis          pure decision engine — no I/O, unit-tested without infra
  src/engine            engine-neutral ports (collector, executor, session)
  src/mongo             the MongoDB adapter; zod-parses driver output at the boundary
  src/jobs              graphile-worker tasks (collect/classify/suggest/apply/finalize)
  src/db                Drizzle schema, client, secret sealing
apps/web                dashboard
packages/contracts      oRPC + zod contracts shared by api and web
```

Everything engine-specific sits behind the ports in `src/engine`, so PostgreSQL
and SQL Server adapters can slot in without pipeline changes — the data model
already carries an `engine` field.

## Develop

```bash
cp .env.example .env      # then fill secrets
npm install
docker compose up         # postgres + mongo + api + web + worker, hot reload
```

`npm run build` · `npm run typecheck` · `npm run lint` · `npm run test` (unit) ·
`npm run db:generate` · `npm run db:migrate`. Production migrations run the
compiled migrator: `npm run db:deploy -w @repo/api`.

**House rule: the api and the web app run clean.** No errors and no warnings in
server logs, build output, or the browser console. A warning is a defect — fix
the cause, don't silence it. See architecture §16.

## Security posture (defaults)

Both defaults exist because the control plane dials hosts that users name.

- **Sign-up is invite-only** (`SIGNUP_MODE`). The first account bootstraps the
  install. `open` hands that outbound reach to strangers.
- **Private targets are refused** unless `ALLOW_PRIVATE_CLUSTER_TARGETS=true`.
  Cloud metadata ranges stay blocked either way, DNS and SRV are resolved before
  dialing, and every host in a multi-host string is checked.

## Deploy

Slim images via `turbo prune` (api ≈ 390 MB, web ≈ 235 MB):

```bash
docker build -f apps/api/Dockerfile -t indexterity-api .
docker build -f apps/web/Dockerfile -t indexterity-web .
```

One web image serves every environment — `API_URL` and `WEB_ORIGIN` are read at
runtime. The worker deploys from the api image with
`CMD ["node", "apps/api/dist/worker.js"]`, or set `RUN_WORKER=true` to embed it
in the api for a one-container install. Hosted should keep them separate: an api
rollout would otherwise abort an in-flight index build, and the alert cooldown
assumes a single worker.

A Helm chart is in [`deploy/helm/indexterity`](./deploy/helm/indexterity) —
api + dashboard + worker, a pre-upgrade migration hook, ingress, and a
`helm test`. Bring your own PostgreSQL.

## Open

Engine depth from the original roadmap is done: collation-aware redundancy,
replica-aware ROI, aggregation shapes, create cost estimates, the
`maxCollectionSizeBytes` ceiling, the advisory tier, TTL suggestions, and the
read-only digest.

**Atlas Admin API onboarding is dropped, not deferred.** An admin API key is a
bigger ask than the `createRole` snippet it would replace, and it hands us a
credential to guard. Atlas clusters get the guided 422 naming the commands to
run in their own console.

**How urgent a missing index is** comes from `docsExamined` — the documents the
server actually walked — not from table size:

| the scan | treatment |
|----------|-----------|
| ≥ 10M documents walked, or ≥ 500k per execution | **critical** — auto-approved with `instantCreate`, and the build skips the change window |
| ≥ 1M walked, or a collection over 100k documents | elevated — auto-approved with `instantCreate`, build waits for the window |
| anything smaller | routine — proposed for a human |

Workload analysis runs **hourly**, not on the 6h collect cadence, because a
missing index costs on every execution and most of the old delay was waiting to
notice. A critical scan now goes from first sighting to built index in minutes
rather than the better part of a day.

## Notes

npm workspaces. Docker resolves to podman + `podman-compose` here; the compose
file works with either.
