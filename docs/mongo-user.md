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
    // Workload analysis via $queryStats (mongo 7+). Also set the server
    // parameter internalQueryStatsRateLimit > 0 (e.g. 100).
    { resource: { cluster: true }, actions: ["queryStatsRead"] },
  ],
  roles: [],
})
db.createUser({
  user: "indexterity",
  pwd: "<generate a strong password>",
  roles: ["indexterityAnalyze"],
})
```

Profiler fallback (mongo < 7, or `$queryStats` disabled): additionally grant
`find` on each analyzed database's `system.profile` collection and enable the
profiler (`db.setProfilingLevel(2)` or level 1 with a slow-ms threshold).

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
