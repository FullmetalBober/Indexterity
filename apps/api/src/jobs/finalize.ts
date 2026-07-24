import { isRegression } from "@repo/core";
import { actions, and, createDatabase, eq, policies, recommendations, roiMetrics } from "@repo/db";
import { MongoIndexCollector, MongoIndexExecutor, serializeSpec } from "@repo/mongo";
import { requiredEnv } from "../env";
import { openClusterMongo } from "./cluster-connection";
import { preflightDrop } from "./preflight";

const DEFAULT_OBSERVE_DAYS = 30;
const DAY_MS = 86_400_000;
const REGRESSION_OPTIONS = { factor: 1.5, minWindowOps: 20 };

// HIDDEN drops whose observe window has elapsed -> pre-flight -> drop -> DROPPED.
// The drop is the only irreversible step. A failed pre-flight during observe
// un-hides the index and re-proposes it (the reversible safety path). Freed
// bytes are recorded to roi_metrics for the dashboard headline.
export async function finalizeCluster(clusterId: string): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const periodStart = new Date();
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
    // Demo/read-only clusters never execute writes.
    if (demoMode) return 0;
    const collector = new MongoIndexCollector(conn);
    const executor = new MongoIndexExecutor(conn, demoMode);
    let dropped = 0;
    let freedBytes = 0;
    for (const rec of due) {
      // Regression gate: did hiding this index slow the collection's reads
      // during observe? If so, un-hide and re-propose instead of dropping.
      if (rec.baselineReadOps !== null && rec.baselineReadLatency !== null) {
        const current = await collector.readLatency(rec.database, rec.collection);
        const baseline = { ops: rec.baselineReadOps, latencyMicros: rec.baselineReadLatency };
        if (isRegression(baseline, current, REGRESSION_OPTIONS)) {
          await executor.unhide(rec.database, rec.collection, rec.indexName);
          await db
            .update(recommendations)
            .set({ state: "PROPOSED", hiddenAt: null, updatedAt: new Date() })
            .where(eq(recommendations.id, rec.id));
          await db.insert(actions).values({
            recommendationId: rec.id,
            kind: "DROP",
            actor: "system",
            result: "aborted: read-latency regression during observe",
          });
          continue;
        }
      }
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
      freedBytes += rec.estimatedBytesSaved;
      dropped += 1;
    }
    if (dropped > 0) {
      await db.insert(roiMetrics).values({
        clusterId,
        freedBytes,
        indexCountDelta: dropped,
        periodStart,
        periodEnd: new Date(),
      });
    }
    return dropped;
  } finally {
    await conn.close();
  }
}
