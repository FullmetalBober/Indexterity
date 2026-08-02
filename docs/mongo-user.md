# Connecting a cluster: the MongoDB user Indexterity needs

Indexterity never reads your documents. Give it a dedicated user with an
index-only role — start with analyze-only, upgrade to live-manage when you flip
the cluster out of read-only mode.

## 1. Analyze-only (read-only mode)

Enough for collection/index stats, latency and `$queryStats` workload analysis:

```js
use admin
db.createRole({
  role: "indexterityAnalyze",
  privileges: [
    { resource: { db: "", collection: "" },
      actions: ["listCollections", "listIndexes", "indexStats", "collStats"] },
    { resource: { cluster: true }, actions: ["listDatabases"] },
    // Workload analysis via $queryStats. Read the two notes below — the grant
    // alone is not enough to make the store useful.
    { resource: { cluster: true }, actions: ["queryStatsRead"] },
    // Optional: the five-minute health probe. See "What serverStatus exposes".
    { resource: { cluster: true }, actions: ["serverStatus"] },
  ],
  roles: [],
})
db.createUser({
  user: "indexterity",
  pwd: "<generate a strong password>",
  roles: ["indexterityAnalyze"],
})
```

**`$queryStats` does not record anything by default.** `internalQueryStatsRateLimit`
is `0` on a stock server of every version, and at `0` the store stays empty no
matter how privileged the user is. Set it to `-1` (record every shape) or to a
per-second cap such as `100`. Indexterity checks this when you connect and says
so if it is off.

**Before MongoDB 8.0 the store reports execution counts only** — no
`docsExamined`, `keysExamined` or `hasSortStage`, which is the difference
between knowing a query ran and knowing it scanned. On 6.0 and 7.0 the profiler
is therefore the only source that can suggest an index, and Indexterity falls
back to it automatically.

Profiler fallback (any version): additionally grant `find` on each analyzed
database's `system.profile` collection and enable the profiler
(`db.setProfilingLevel(2)`, or level 1 with a slow-ms threshold). The profiler
is the richer source below 8.0 — it records the plan summary, the documents
walked, whether a blocking in-memory sort ran, and the client's app name.

### What `serverStatus` exposes

`serverStatus` is optional and sits outside the index-only story, so it is worth
being explicit: it is a **server-wide** command, and it reports more than
indexes. Indexterity reads the query-engine counters from it (collection scans,
documents and index keys walked, unindexed sorts, operations queued behind the
global lock) to notice a scan storm spread across many collections. The same
document also carries connection counts, network byte totals, replication state
and storage-engine internals, and granting the action means the user can read
all of it.

It still cannot read a single one of your documents — that needs `find`, which
this role never grants. Skip the privilege if you would rather not share the
rest: the cluster onboards clean without it and only loses the health probe.

## 2. Live-manage (after "Go live")

Adds the three index write operations — still nothing that touches documents:

```js
use admin
db.grantPrivilegesToRole("indexterityAnalyze", [
  { resource: { db: "", collection: "" },
    actions: ["createIndex", "dropIndex", "collMod"] }, // collMod = hide/unhide
])
```

## 3. Sharded clusters

Connect to the `mongos`. For shard-key protection (indexes backing the shard
key are never dropped), also grant read on config:

```js
db.grantRolesToUser("indexterity", [{ role: "read", db: "config" }])
```

## 4. Connection string

```
mongodb://indexterity:<password>@host1,host2/?replicaSet=rs0&authSource=admin
```

`mongodb://` and `mongodb+srv://` are the only accepted schemes. The string is
envelope-encrypted at rest in the control plane; rotate the password anytime and
re-connect the cluster.
