import { recommendCreates } from "@repo/core";
import { and, createDatabase, eq, inArray, policies, recommendations } from "@repo/db";
import { MongoIndexCollector } from "@repo/mongo";
import { requiredEnv } from "../env";
import { openClusterMongo } from "./cluster-connection";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);
const WORKLOAD_OPTIONS = { minCount: 1 };
const MIN_COLLECTION_DOCS = 1000;

function proposedName(keys: readonly string[]): string {
  return keys.map((field) => `${field}_1`).join("_");
}

// Workload analysis (opt-in): read the profiler and propose CREATE/UPDATE/MERGE.
// Requires policy.workloadAnalysis — reading system.profile exposes query field
// names, so it is the higher-trust tier (docs/architecture.md §9.1). Read-only,
// so it runs even for demo-mode clusters.
export async function suggestForCluster(clusterId: string): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  if (policy?.workloadAnalysis !== true) return 0;

  const { conn } = await openClusterMongo(db, clusterId);
  try {
    const collector = new MongoIndexCollector(conn);
    const databases = (await conn.listDatabaseNames()).filter(
      (name) => !SYSTEM_DATABASES.has(name),
    );
    const toInsert: Array<typeof recommendations.$inferInsert> = [];
    for (const database of databases) {
      for (const collection of await collector.listCollectionNames(database)) {
        // Collection-scans only matter on non-trivial collections.
        const docCount = await conn.db(database).collection(collection).estimatedDocumentCount();
        if (docCount < MIN_COLLECTION_DOCS) continue;
        const [shapes, existing] = await Promise.all([
          collector.collectSlowQueries(database, collection),
          collector.listIndexes(database, collection),
        ]);
        for (const candidate of recommendCreates(shapes, existing, WORKLOAD_OPTIONS)) {
          toInsert.push({
            clusterId,
            type: candidate.type,
            state: "PROPOSED",
            database,
            collection,
            indexName: proposedName(candidate.keys),
            rationale: candidate.rationale,
            estimatedBytesSaved: 0,
            targetSpec: { keys: [...candidate.keys], retire: [...candidate.retireIndexes] },
          });
        }
      }
    }
    // Replace prior workload proposals; leave drop recommendations untouched.
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
    return toInsert.length;
  } finally {
    await conn.close();
  }
}
