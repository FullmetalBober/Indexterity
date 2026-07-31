import { createScore, type IndexSpec, recommendCreates, type SortKey } from "../analysis";
import { and, eq, inArray, indexCooldowns, like, or, policies, recommendations } from "../db";
import { openClusterSession } from "./cluster-connection";
import { activeCooldownKeys, cooldownKey } from "./cooldowns";
import { applyCreatesForCluster } from "./create";
import { jobDb } from "./db";

// A shape must recur before it earns a recommendation — someone running a
// heavy ad-hoc query once or twice must not leave an index behind.
const WORKLOAD_OPTIONS = { minCount: 3 };
// A TTL advisory needs a RECURRING delete pattern, not a one-off cleanup.
const TTL_MIN_DELETES = 3;
const MIN_COLLECTION_DOCS = 1000;
// A collection scan on a collection this large is "critical" (instant-apply eligible).
const CRITICAL_COLLECTION_DOCS = 10_000;
// Instant apply (build without human approval) demands stronger recurrence
// than merely proposing.
const INSTANT_MIN_COUNT = 5;

function proposedName(keys: readonly SortKey[]): string {
  return keys.map((key) => `${key.field}_${key.direction}`).join("_");
}

// targetSpec key encoding: plain = ascending, ":-1" suffix = descending.
function encodeKeys(keys: readonly SortKey[]): string[] {
  return keys.map((key) => (key.direction === -1 ? `${key.field}:-1` : key.field));
}

// Workload analysis (opt-in): read the profiler and propose CREATE/UPDATE/MERGE.
// A brand-new index on a critical collection, when instantCreate is opted in and
// the cluster is writable, is auto-approved and built immediately
// (creates only — never drops; docs/architecture.md §7.5).
export async function suggestForCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  if (policy?.workloadAnalysis !== true) return 0;
  const cooled = await activeCooldownKeys(db, clusterId);
  // Full cooldown history — a previously rolled-back build cuts the score hard.
  const cooldownRows = await db
    .select()
    .from(indexCooldowns)
    .where(eq(indexCooldowns.clusterId, clusterId));
  const regressionCounts = new Map<string, number>();
  for (const row of cooldownRows) {
    regressionCounts.set(`${row.database} ${row.collection} ${row.indexName}`, row.regressionCount);
  }

  const { session, readOnly, release } = await openClusterSession(db, clusterId);
  let created = 0;
  let instantApproved = 0;
  try {
    const collector = session.collector;
    const databases = await session.listDatabaseNames();
    const toInsert: Array<typeof recommendations.$inferInsert> = [];
    // Index lists already fetched this run, keyed "db\0coll" — reused when
    // resolving $lookup wants against foreign collections.
    const indexCache = new Map<string, IndexSpec[]>();
    // $lookup joins seen across all shapes: foreign collection + field -> count.
    const lookupWants = new Map<
      string,
      { database: string; from: string; foreignField: string; count: number }
    >();
    for (const database of databases) {
      for (const collection of await collector.listCollectionNames(database)) {
        // TTL advisories run BEFORE the size gate: a collection with recurring
        // age-based deletes is small BY DESIGN (it's being pruned). The app
        // already deletes by age — a TTL index would do it automatically.
        // Indexterity NEVER builds TTL indexes (they delete documents), so this
        // is advisory-only, excluded from every auto-approve path.
        const deletePatterns = await collector.collectDeletePatterns(database, collection);
        const ttlWorthy = deletePatterns.filter((pattern) => pattern.count >= TTL_MIN_DELETES);
        if (ttlWorthy.length > 0) {
          const currentIndexes = await collector.listIndexes(database, collection);
          for (const pattern of ttlWorthy) {
            if (currentIndexes.some((idx) => idx.ttl && idx.keys[0]?.field === pattern.field)) {
              continue;
            }
            const indexName = `${pattern.field}_1_ttl`;
            if (cooled.has(cooldownKey(database, collection, indexName))) continue;
            const days = Math.max(1, Math.round(pattern.medianRetentionSeconds / 86_400));
            toInsert.push({
              clusterId,
              type: "ADVISORY_REVIEW",
              state: "PROPOSED",
              database,
              collection,
              indexName,
              rationale:
                `Recurring age-based deletes on ${pattern.field} (${pattern.count}× in the profiler, ` +
                `retention ≈ ${days} days). A TTL index would expire documents automatically and ` +
                `steadily: db.${collection}.createIndex({ ${pattern.field}: 1 }, { expireAfterSeconds: ${pattern.medianRetentionSeconds} }). ` +
                `CAUTION: TTL deletes documents — verify the retention window and create it yourself; Indexterity never builds TTL indexes.`,
              score: Math.min(80, 30 + pattern.count * 10),
              estimatedBytesSaved: 0,
            });
          }
        }

        // Counts come from $collStats, not the count command — the scoped
        // least-privilege user has no `find` grant, which `count` requires.
        const { dataSizeBytes, docCount } = await collector.collectionStorage(database, collection);
        if (docCount < MIN_COLLECTION_DOCS) continue;
        // Policy ceiling: building an index on a huge collection is the one
        // expensive create-side operation — skip collections above the limit.
        if (
          policy.maxCollectionSizeBytes !== null &&
          dataSizeBytes > policy.maxCollectionSizeBytes
        ) {
          continue;
        }
        const critical = docCount >= CRITICAL_COLLECTION_DOCS;
        const [shapes, existing, sizes] = await Promise.all([
          collector.collectWorkload(database, collection),
          collector.listIndexes(database, collection),
          collector.indexSizes(database, collection),
        ]);
        indexCache.set(`${database}\u0000${collection}`, existing);
        // Record $lookup joins for the post-loop foreign-side pass.
        for (const shape of shapes) {
          for (const join of shape.lookups ?? []) {
            const key = `${database}\u0000${join.from}\u0000${join.foreignField}`;
            const prev = lookupWants.get(key) ?? {
              database,
              from: join.from,
              foreignField: join.foreignField,
              count: 0,
            };
            prev.count += shape.count;
            lookupWants.set(key, prev);
          }
        }
        // A new index isn't free: estimate its size from this collection's
        // average existing index, and remind about the extra write per insert.
        const sizeValues = Object.values(sizes);
        const avgIndexBytes =
          sizeValues.length > 0
            ? sizeValues.reduce((sum, value) => sum + value, 0) / sizeValues.length
            : docCount * 16;
        const cost = ` Est. build ≈ ${Math.max(1, Math.round(avgIndexBytes / 1024))} KB (+1 write per doc write).`;
        for (const candidate of recommendCreates(shapes, existing, WORKLOAD_OPTIONS)) {
          // Partial variants get a suffix so they never collide with the full
          // index of the same keys.
          const indexName =
            proposedName(candidate.keys) +
            (candidate.partialFilter === undefined ? "" : "_partial");
          if (cooled.has(cooldownKey(database, collection, indexName))) continue;
          const score = createScore({
            collscan: true,
            count: candidate.count,
            docCount,
            pastRegressions: regressionCounts.get(`${database} ${collection} ${indexName}`) ?? 0,
          });
          const instant =
            candidate.type === "CREATE" &&
            critical &&
            candidate.count >= INSTANT_MIN_COUNT &&
            policy.instantCreate &&
            !readOnly;
          if (instant) instantApproved += 1;
          toInsert.push({
            clusterId,
            type: candidate.type,
            state: instant ? "APPROVED" : "PROPOSED",
            database,
            collection,
            indexName,
            rationale:
              (instant ? `${candidate.rationale} (auto-approved: critical)` : candidate.rationale) +
              cost,
            score,
            estimatedBytesSaved: 0,
            targetSpec: {
              keys: encodeKeys(candidate.keys),
              retire: [...candidate.retireIndexes],
              ...(candidate.partialFilter === undefined
                ? {}
                : { partial: { ...candidate.partialFilter } }),
            },
          });
        }
      }
    }
    // Foreign-side $lookup indexes: a join field with no leading index makes
    // every joined document scan the foreign collection.
    for (const want of lookupWants.values()) {
      const cacheKey = `${want.database}\u0000${want.from}`;
      let foreignIndexes = indexCache.get(cacheKey);
      if (foreignIndexes === undefined) {
        try {
          foreignIndexes = await collector.listIndexes(want.database, want.from);
        } catch {
          continue; // foreign collection gone — no signal
        }
        indexCache.set(cacheKey, foreignIndexes);
      }
      if (foreignIndexes.some((idx) => idx.keys[0]?.field === want.foreignField)) continue;
      // Same size gate as other creates — a tiny foreign collection scans cheaply.
      const { docCount: foreignDocs } = await collector.collectionStorage(want.database, want.from);
      if (foreignDocs < MIN_COLLECTION_DOCS) continue;
      const indexName = `${want.foreignField}_1`;
      if (cooled.has(cooldownKey(want.database, want.from, indexName))) continue;
      if (
        toInsert.some(
          (row) =>
            row.database === want.database &&
            row.collection === want.from &&
            row.indexName === indexName,
        )
      ) {
        continue;
      }
      toInsert.push({
        clusterId,
        type: "CREATE",
        state: "PROPOSED",
        database: want.database,
        collection: want.from,
        indexName,
        rationale:
          `$lookup joins ${want.database}.${want.from} on ${want.foreignField} ` +
          `(seen ${want.count}×) — without this index every joined document scans ${want.from}.`,
        score: createScore({
          collscan: true,
          count: want.count,
          docCount: foreignDocs,
          pastRegressions: regressionCounts.get(`${want.database} ${want.from} ${indexName}`) ?? 0,
        }),
        estimatedBytesSaved: 0,
        targetSpec: { keys: [want.foreignField], retire: [] },
      });
    }
    await db
      .delete(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          eq(recommendations.state, "PROPOSED"),
          or(
            inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE"]),
            and(
              eq(recommendations.type, "ADVISORY_REVIEW"),
              like(recommendations.indexName, "%_ttl"),
            ),
          ),
        ),
      );
    if (toInsert.length > 0) await db.insert(recommendations).values(toInsert);
    created = toInsert.length;
  } finally {
    release();
  }
  // Build the auto-approved critical creates now, without waiting for the scheduler.
  if (instantApproved > 0) await applyCreatesForCluster(clusterId);
  return created;
}
