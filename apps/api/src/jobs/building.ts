import { actions, and, type Database, eq, recommendations } from "../db";
import { openClusterSession } from "./cluster-connection";

// BUILDING -> ACTIVE, once the cluster says the index is really there (#332).
//
// Only PostgreSQL's pg_cron route produces a BUILDING row: create() returns as
// soon as the job is registered and the index appears minutes later in a
// background worker. Every other engine builds synchronously and never lands
// here, which is why the port method is optional and its absence means "nothing
// to settle" rather than "unsupported".
//
// Runs at the START of the apply task, ahead of new builds: a row still building
// is one this cluster is already paying for, and settling it first is what keeps
// the next pass from proposing around a half-finished index.
export async function settleBuildsForCluster(db: Database, clusterId: string): Promise<number> {
  const building = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "BUILDING")));
  if (building.length === 0) return 0;
  const { session, release } = await openClusterSession(db, clusterId);
  try {
    const executor = session.executor(false);
    const settle = executor.settleBuild?.bind(executor);
    // An engine with no asynchronous build cannot answer for these rows. Left
    // alone rather than failed: the only way to get here is an adapter change
    // under rows an earlier version wrote, and discarding somebody's approved
    // build over that would be the wrong repair.
    if (settle === undefined) return 0;
    let settled = 0;
    const collector = session.collector;
    for (const rec of building) {
      const outcome = await settle(rec.database, rec.collection, rec.indexName);
      if (outcome.state === "PENDING") continue;
      if (outcome.state === "FAILED") {
        // Back to APPROVED, not REJECTED: the customer's decision to build this
        // index still stands, and what failed was one attempt at it. The next
        // apply pass retries, and a build that fails for a real reason — a
        // unique index over duplicate rows, say — fails again with the same
        // message rather than being silently forgotten.
        await db
          .update(recommendations)
          .set({ state: "APPROVED", updatedAt: new Date() })
          .where(eq(recommendations.id, rec.id));
        await db.insert(actions).values({
          recommendationId: rec.id,
          kind: "CREATE",
          actor: "system",
          // The server's own text. A failed concurrent build also leaves an
          // INVALID index behind, which the scoped role cannot drop — it owns
          // nothing and DROP INDEX CONCURRENTLY cannot run from a function — so
          // the statement that removes it is named here rather than left for
          // somebody to work out.
          result:
            `failed: ${outcome.message.trim()} — a failed concurrent build leaves an ` +
            `invalid index behind, which this role cannot remove: DROP INDEX CONCURRENTLY ` +
            `IF EXISTS ${rec.indexName}`,
        });
        settled += 1;
        continue;
      }
      // The baseline is taken HERE and not at schedule time, which is the whole
      // reason BUILDING exists. Measured before the index was built, it would be
      // a reading of a table the index is not on — and that is the reference the
      // post-build regression watch compares against, so a wrong one does not
      // fail loudly, it silently mis-decides every later comparison.
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
      settled += 1;
    }
    return settled;
  } finally {
    release();
  }
}
