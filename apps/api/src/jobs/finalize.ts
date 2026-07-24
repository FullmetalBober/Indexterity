import { actions, and, createDatabase, eq, policies, recommendations } from "@repo/db";
import { MongoIndexCollector, MongoIndexExecutor } from "@repo/mongo";
import { requiredEnv } from "../env";
import { openClusterMongo } from "./cluster-connection";
import { serializeSpec } from "./collect";
import { preflightDrop } from "./preflight";

const DEFAULT_OBSERVE_DAYS = 30;
const DAY_MS = 86_400_000;

// HIDDEN drops whose observe window has elapsed -> pre-flight -> drop -> DROPPED.
// The drop is the only irreversible step. A failed pre-flight during observe
// un-hides the index and re-proposes it (the reversible safety path).
export async function finalizeCluster(clusterId: string): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  const observeDays = policy?.observeWindowDays ?? DEFAULT_OBSERVE_DAYS;

  const hiddenRecs = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "HIDDEN")));
  const now = Date.now();
  const due = hiddenRecs.filter(
    (rec) => rec.hiddenAt !== null && now - rec.hiddenAt.getTime() >= observeDays * DAY_MS,
  );
  if (due.length === 0) return 0;

  const { conn, demoMode } = await openClusterMongo(db, clusterId);
  try {
    const collector = new MongoIndexCollector(conn);
    const executor = new MongoIndexExecutor(conn, demoMode);
    let dropped = 0;
    for (const rec of due) {
      const check = await preflightDrop(collector, rec);
      if (!check.safe) {
        if (check.spec !== null) {
          await executor.unhide(rec.database, rec.collection, rec.indexName);
          await db
            .update(recommendations)
            .set({ state: "PROPOSED", hiddenAt: null, updatedAt: new Date() })
            .where(eq(recommendations.id, rec.id));
          await db.insert(actions).values({
            recommendationId: rec.id,
            kind: "DROP",
            actor: "system",
            result: `aborted + un-hidden: ${check.reason}`,
          });
        } else {
          await db
            .update(recommendations)
            .set({ state: "DROPPED", updatedAt: new Date() })
            .where(eq(recommendations.id, rec.id));
          await db.insert(actions).values({
            recommendationId: rec.id,
            kind: "DROP",
            actor: "system",
            result: "index already absent",
          });
        }
        continue;
      }
      await executor.drop(rec.database, rec.collection, rec.indexName);
      await db
        .update(recommendations)
        .set({ state: "DROPPED", updatedAt: new Date() })
        .where(eq(recommendations.id, rec.id));
      await db.insert(actions).values({
        recommendationId: rec.id,
        kind: "DROP",
        actor: "system",
        result: "ok",
        rollbackToken: check.spec === null ? null : { spec: serializeSpec(check.spec) },
      });
      dropped += 1;
    }
    return dropped;
  } finally {
    await conn.close();
  }
}
