import { actions, and, createDatabase, eq, inArray, recommendations } from "@repo/db";
import { MongoIndexExecutor } from "@repo/mongo";
import { requiredEnv } from "../env";
import { openClusterMongo } from "./cluster-connection";

// APPROVED CREATE/UPDATE/MERGE -> build the index (executor.create) -> ACTIVE.
// Retiring superseded indexes is left to the next classify pass, which sees them
// as DROP_REDUNDANT and routes them through the safe hide -> observe -> drop path.
export async function applyCreatesForCluster(clusterId: string): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const approved = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        eq(recommendations.state, "APPROVED"),
        inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE"]),
      ),
    );
  if (approved.length === 0) return 0;

  const { conn, demoMode } = await openClusterMongo(db, clusterId);
  try {
    if (demoMode) return 0;
    const executor = new MongoIndexExecutor(conn, demoMode);
    let built = 0;
    for (const rec of approved) {
      const target = rec.targetSpec;
      if (target === null || target.keys.length === 0) continue;
      const keys: Record<string, 1 | -1> = {};
      for (const field of target.keys) keys[field] = 1;
      await executor.create(rec.database, rec.collection, keys, { name: rec.indexName });
      await db
        .update(recommendations)
        .set({ state: "ACTIVE", updatedAt: new Date() })
        .where(eq(recommendations.id, rec.id));
      await db.insert(actions).values({
        recommendationId: rec.id,
        kind: "CREATE",
        actor: "system",
        result: "ok",
        rollbackToken: { indexName: rec.indexName },
      });
      built += 1;
    }
    return built;
  } finally {
    await conn.close();
  }
}
