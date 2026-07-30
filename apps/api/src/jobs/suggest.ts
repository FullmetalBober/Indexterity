import { createScore, recommendCreates, type SortKey } from "../analysis";
import { and, eq, inArray, indexCooldowns, like, or, policies, recommendations } from "../db";
import { MongoIndexCollector } from "../mongo";
import { openClusterMongo } from "./cluster-connection";
import { activeCooldownKeys, cooldownKey } from "./cooldowns";
import { applyCreatesForCluster } from "./create";
import { jobDb } from "./db";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);
const WORKLOAD_OPTIONS = { minCount: 1 };
// A TTL advisory needs a RECURRING delete pattern, not a one-off cleanup.
const TTL_MIN_DELETES = 3;
const MIN_COLLECTION_DOCS = 1000;
// A collection scan on a collection this large is "critical" (instant-apply eligible).
const CRITICAL_COLLECTION_DOCS = 10_000;

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

  const { conn, readOnly, release } = await openClusterMongo(db, clusterId);
  let created = 0;
  let instantApproved = 0;
  try {
    const collector = new MongoIndexCollector(conn);
    const databases = (await conn.listDatabaseNames()).filter(
      (name) => !SYSTEM_DATABASES.has(name),
    );
    const toInsert: Array<typeof recommendations.$inferInsert> = [];
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

        const docCount = await conn.db(database).collection(collection).estimatedDocumentCount();
        if (docCount < MIN_COLLECTION_DOCS) continue;
        // Policy ceiling: building an index on a huge collection is the one
        // expensive create-side operation — skip collections above the limit.
        if (policy.maxCollectionSizeBytes !== null) {
          const dataSize = await collector.collectionDataSize(database, collection);
          if (dataSize > policy.maxCollectionSizeBytes) continue;
        }
        const critical = docCount >= CRITICAL_COLLECTION_DOCS;
        const [shapes, existing, sizes] = await Promise.all([
          collector.collectWorkload(database, collection),
          collector.listIndexes(database, collection),
          collector.indexSizes(database, collection),
        ]);
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
            candidate.type === "CREATE" && critical && policy.instantCreate && !readOnly;
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
