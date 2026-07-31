import { inChangeWindow } from "../analysis";
import { actions, and, eq, inArray, policies, recommendations } from "../db";
import { effectiveChangeWindow } from "./change-window";
import { openClusterSession } from "./cluster-connection";
import { jobDb } from "./db";

// APPROVED CREATE/UPDATE/MERGE -> build the index (executor.create) -> ACTIVE.
// Retiring superseded indexes is left to the next classify pass, which sees them
// as DROP_REDUNDANT and routes them through the safe hide -> observe -> drop path.
// At build time the collection's write latency is recorded as the baseline for
// the post-build regression watch (finalize drops the index if writes regress).
export async function applyCreatesForCluster(clusterId: string): Promise<number> {
  const db = jobDb();
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
  // Builds are elective and can spike load — they wait for the change window.
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  const window = effectiveChangeWindow({
    changeWindowStartHour: policy?.changeWindowStartHour ?? null,
    changeWindowEndHour: policy?.changeWindowEndHour ?? null,
    inferredWindowStartHour: policy?.inferredWindowStartHour ?? null,
    inferredWindowEndHour: policy?.inferredWindowEndHour ?? null,
  });
  if (!inChangeWindow(new Date(), window.startHour, window.endHour)) {
    return 0;
  }

  const { session, readOnly, release } = await openClusterSession(db, clusterId);
  try {
    if (readOnly) return 0;
    const collector = session.collector;
    const executor = session.executor(readOnly);
    let built = 0;
    for (const rec of approved) {
      const target = rec.targetSpec;
      if (target === null || target.keys.length === 0) continue;
      // targetSpec keys encode direction as a ":-1" suffix ("at:-1"); plain
      // entries are ascending. Older rows are plain-ascending and still parse.
      const keys: Record<string, 1 | -1> = {};
      for (const entry of target.keys) {
        if (entry.endsWith(":-1")) keys[entry.slice(0, -3)] = -1;
        else keys[entry] = 1;
      }
      await executor.create(rec.database, rec.collection, keys, {
        name: rec.indexName,
        ...(target.partial === undefined ? {} : { partialFilterExpression: target.partial }),
      });
      // Write-latency baseline at build time — the reference for the post-build watch.
      const { writes } = await collector.collectionLatency(rec.database, rec.collection);
      await db
        .update(recommendations)
        .set({
          state: "ACTIVE",
          builtAt: new Date(),
          baselineWriteOps: writes.ops,
          baselineWriteLatency: writes.latencyMicros,
          updatedAt: new Date(),
        })
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
    release();
  }
}
