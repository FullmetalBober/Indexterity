import { inChangeWindow, isRegression } from "../analysis";
import { actions, and, eq, inArray, policies, recommendations, roiMetrics } from "../db";
import { notifyClusterOwners } from "../mail/notify";
import { serializeSpec } from "../mongo";
import { openClusterSession } from "./cluster-connection";
import { recordRegression } from "./cooldowns";
import { jobDb } from "./db";
import { preflightDrop } from "./preflight";

const DEFAULT_OBSERVE_DAYS = 30;
const DAY_MS = 86_400_000;
const REGRESSION_OPTIONS = { factor: 1.5, minWindowOps: 20 };

// HIDDEN drops whose observe window has elapsed -> pre-flight -> drop -> DROPPED.
// The drop is the only irreversible step. A failed pre-flight during observe
// un-hides the index and re-proposes it (the reversible safety path). Freed
// bytes are recorded to roi_metrics for the dashboard headline.
export async function finalizeCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const periodStart = new Date();
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  const observeDays = policy?.observeWindowDays ?? DEFAULT_OBSERVE_DAYS;
  // Gates only the ELECTIVE drop below. Safety actions — regression unhide,
  // write-watch rollback — always run; deferring them would prolong harm.
  const windowOpen = inChangeWindow(
    new Date(),
    policy?.changeWindowStartHour ?? null,
    policy?.changeWindowEndHour ?? null,
  );

  const hiddenRecs = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "HIDDEN")));
  const now = Date.now();
  const due = hiddenRecs.filter(
    (rec) => rec.hiddenAt !== null && now - rec.hiddenAt.getTime() >= observeDays * DAY_MS,
  );
  // Built indexes still under the post-build write watch.
  const watched = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        eq(recommendations.state, "ACTIVE"),
        inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE"]),
      ),
    );
  if (due.length === 0 && watched.length === 0) return 0;

  const { session, readOnly, release } = await openClusterSession(db, clusterId);
  try {
    // Read-only clusters never execute writes.
    if (readOnly) return 0;
    const collector = session.collector;
    const executor = session.executor(readOnly);
    let dropped = 0;
    let freedBytes = 0;

    // Post-build watch: a freshly built index that slows the collection's writes
    // gets dropped and cooled down; one that survives the window graduates.
    for (const rec of watched) {
      if (
        rec.builtAt === null ||
        rec.baselineWriteOps === null ||
        rec.baselineWriteLatency === null
      ) {
        continue;
      }
      if (now - rec.builtAt.getTime() >= observeDays * DAY_MS) {
        await db
          .update(recommendations)
          .set({ baselineWriteOps: null, baselineWriteLatency: null, updatedAt: new Date() })
          .where(eq(recommendations.id, rec.id));
        continue;
      }
      const { writes } = await collector.collectionLatency(rec.database, rec.collection);
      const baseline = { ops: rec.baselineWriteOps, latencyMicros: rec.baselineWriteLatency };
      if (!isRegression(baseline, writes, REGRESSION_OPTIONS)) continue;
      await executor.drop(rec.database, rec.collection, rec.indexName);
      const until = await recordRegression(
        db,
        clusterId,
        { database: rec.database, collection: rec.collection, indexName: rec.indexName },
        observeDays,
        "write-latency regression after build",
      );
      const day = until.toISOString().slice(0, 10);
      await db
        .update(recommendations)
        .set({
          state: "ROLLED_BACK",
          rationale: `${rec.rationale} — rolled back: write-latency regression; cooling down until ${day}`,
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id));
      await db.insert(actions).values({
        recommendationId: rec.id,
        kind: "DROP",
        actor: "system",
        result: `rolled back + cooldown until ${day}: write-latency regression after build`,
      });
      await notifyClusterOwners(
        db,
        clusterId,
        `rolled back ${rec.indexName}`,
        `The index ${rec.indexName} on ${rec.database}.${rec.collection} slowed writes after being built, so it was dropped automatically. It is cooling down until ${day}.`,
      );
    }
    for (const rec of due) {
      // Regression gate: did hiding this index slow the collection's reads
      // during observe? If so, un-hide and re-propose instead of dropping.
      if (rec.baselineReadOps !== null && rec.baselineReadLatency !== null) {
        const current = await collector.readLatency(rec.database, rec.collection);
        const baseline = { ops: rec.baselineReadOps, latencyMicros: rec.baselineReadLatency };
        if (isRegression(baseline, current, REGRESSION_OPTIONS)) {
          await executor.unhide(rec.database, rec.collection, rec.indexName);
          const until = await recordRegression(
            db,
            clusterId,
            { database: rec.database, collection: rec.collection, indexName: rec.indexName },
            observeDays,
            "read-latency regression during observe",
          );
          const day = until.toISOString().slice(0, 10);
          await db
            .update(recommendations)
            .set({
              state: "REJECTED",
              hiddenAt: null,
              rationale: `${rec.rationale} — auto-rejected: read-latency regression; cooling down until ${day}`,
              updatedAt: new Date(),
            })
            .where(eq(recommendations.id, rec.id));
          await db.insert(actions).values({
            recommendationId: rec.id,
            kind: "DROP",
            actor: "system",
            result: `aborted + cooldown until ${day}: read-latency regression during observe`,
          });
          await notifyClusterOwners(
            db,
            clusterId,
            `kept ${rec.indexName} (regression)`,
            `Hiding ${rec.indexName} on ${rec.database}.${rec.collection} slowed reads during the observe window, so the drop was aborted and the index un-hidden. It is cooling down until ${day}.`,
          );
          continue;
        }
      }
      // The regression gate above ran (safety); the drop itself waits for the
      // change window — the index simply stays hidden until a tick inside it.
      if (!windowOpen) continue;
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
      // One ROI row per drop, attributed to its recommendation, so the
      // dashboard can show which index earned what (undo nets it back out).
      await db.insert(roiMetrics).values({
        clusterId,
        recommendationId: rec.id,
        freedBytes: rec.estimatedBytesSaved,
        indexCountDelta: 1,
        periodStart,
        periodEnd: new Date(),
      });
      freedBytes += rec.estimatedBytesSaved;
      dropped += 1;
    }
    if (dropped > 0) {
      await notifyClusterOwners(
        db,
        clusterId,
        `dropped ${dropped} ${dropped === 1 ? "index" : "indexes"}`,
        `${dropped} ${dropped === 1 ? "index" : "indexes"} passed the observe window and regression gates and ${dropped === 1 ? "was" : "were"} dropped, freeing ~${Math.round(freedBytes / 1024)} KB. Undo is available on the dashboard.`,
      );
    }
    return dropped;
  } finally {
    release();
  }
}
