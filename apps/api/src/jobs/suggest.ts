import { recommendCreates } from "../analysis";
import { and, eq, inArray, policies, recommendations } from "../db";
import { MongoIndexCollector } from "../mongo";
import { openClusterMongo } from "./cluster-connection";
import { activeCooldownKeys, cooldownKey } from "./cooldowns";
import { applyCreatesForCluster } from "./create";
import { jobDb } from "./db";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);
const WORKLOAD_OPTIONS = { minCount: 1 };
const MIN_COLLECTION_DOCS = 1000;
// A collection scan on a collection this large is "critical" (instant-apply eligible).
const CRITICAL_COLLECTION_DOCS = 10_000;

function proposedName(keys: readonly string[]): string {
  return keys.map((field) => `${field}_1`).join("_");
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
          const indexName = proposedName(candidate.keys);
          if (cooled.has(cooldownKey(database, collection, indexName))) continue;
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
            estimatedBytesSaved: 0,
            targetSpec: { keys: [...candidate.keys], retire: [...candidate.retireIndexes] },
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
          inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE"]),
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
