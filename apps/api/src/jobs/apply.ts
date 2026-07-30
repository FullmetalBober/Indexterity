import { actions, and, eq, gte, ne, policies, recommendations } from "../db";
import { MongoIndexCollector, MongoIndexExecutor, serializeSpec } from "../mongo";
import { openClusterMongo } from "./cluster-connection";
import { jobDb } from "./db";
import { preflightDrop } from "./preflight";

const DROP_TYPES = new Set(["DROP_UNUSED", "DROP_REDUNDANT", "MERGE"]);

// APPROVED drops -> pre-flight -> hide (collMod hidden:true) -> HIDDEN. Hiding is
// instant and reversible; it starts the observe window. Records an audit action
// with a rollback token. A failed pre-flight re-proposes instead of hiding.
// With policy.autoApply, PROPOSED recommendations are promoted first — the
// hide -> observe -> finalize gates still stand between them and any drop.
export async function applyCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  if (policy?.autoApply === true) {
    await db
      .update(recommendations)
      .set({ state: "APPROVED", updatedAt: new Date() })
      .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "PROPOSED")));
  } else if (policy?.autoApplyScore !== null && policy?.autoApplyScore !== undefined) {
    // Score-gated auto-approval: confident recommendations enter the pipeline on
    // their own; advisories never do. The observe/regression gates still apply.
    await db
      .update(recommendations)
      .set({ state: "APPROVED", updatedAt: new Date() })
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          eq(recommendations.state, "PROPOSED"),
          gte(recommendations.score, policy.autoApplyScore),
          ne(recommendations.type, "ADVISORY_REVIEW"),
        ),
      );
  }
  const approved = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "APPROVED")));
  if (approved.length === 0) return 0;

  const { conn, readOnly, release } = await openClusterMongo(db, clusterId);
  try {
    // Read-only clusters never execute writes.
    if (readOnly) return 0;
    const collector = new MongoIndexCollector(conn);
    const executor = new MongoIndexExecutor(conn, readOnly);
    let hidden = 0;
    for (const rec of approved) {
      if (!DROP_TYPES.has(rec.type)) continue;
      const check = await preflightDrop(collector, rec);
      if (!check.safe) {
        await db
          .update(recommendations)
          .set({ state: "PROPOSED", updatedAt: new Date() })
          .where(eq(recommendations.id, rec.id));
        await db.insert(actions).values({
          recommendationId: rec.id,
          kind: "HIDE",
          actor: "system",
          result: `aborted: ${check.reason}`,
        });
        continue;
      }
      await executor.hide(rec.database, rec.collection, rec.indexName);
      // Baseline read latency at hide time — the reference for regression checks.
      const baseline = await collector.readLatency(rec.database, rec.collection);
      await db
        .update(recommendations)
        .set({
          state: "HIDDEN",
          hiddenAt: new Date(),
          baselineReadOps: baseline.ops,
          baselineReadLatency: baseline.latencyMicros,
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id));
      await db.insert(actions).values({
        recommendationId: rec.id,
        kind: "HIDE",
        actor: "system",
        result: "ok",
        rollbackToken: check.spec === null ? null : { spec: serializeSpec(check.spec) },
      });
      hidden += 1;
    }
    return hidden;
  } finally {
    release();
  }
}
