import { evaluateRegression, inChangeWindow } from "../analysis";
import { actions, and, eq, inArray, policies, recommendations, roiMetrics } from "../db";
import { notifyClusterOwners } from "../mail/notify";
import { serializeSpec } from "../mongo";
import { effectiveChangeWindow } from "./change-window";
import { openClusterSession } from "./cluster-connection";
import { recordRegression } from "./cooldowns";
import { jobDb } from "./db";
import { preflightDrop } from "./preflight";

const DEFAULT_OBSERVE_DAYS = 30;
const DAY_MS = 86_400_000;
const REGRESSION_OPTIONS = { factor: 1.5, minWindowOps: 20 };
// A superseded index is a structural finding backed by a replacement that has
// already proven itself, so it scores like any other redundancy.
const SUPERSEDED_SCORE = 55;

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
  const window = effectiveChangeWindow({
    changeWindowStartHour: policy?.changeWindowStartHour ?? null,
    changeWindowEndHour: policy?.changeWindowEndHour ?? null,
    inferredWindowStartHour: policy?.inferredWindowStartHour ?? null,
    inferredWindowEndHour: policy?.inferredWindowEndHour ?? null,
  });
  const windowOpen = inChangeWindow(new Date(), window.startHour, window.endHour);

  const hiddenRecs = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "HIDDEN")));
  const now = Date.now();
  // Each drop observes for the window decided at hide time (dynamic — periodic
  // usage extends it, proven idleness shortens it); policy is the fallback.
  const due = hiddenRecs.filter(
    (rec) =>
      rec.hiddenAt !== null &&
      now - rec.hiddenAt.getTime() >= (rec.observeDays ?? observeDays) * DAY_MS,
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
      const { writes } = await collector.collectionLatency(rec.database, rec.collection);
      const baseline = { ops: rec.baselineWriteOps, latencyMicros: rec.baselineWriteLatency };
      const verdict = evaluateRegression(baseline, writes, REGRESSION_OPTIONS);
      // The server restarted mid-watch: the baseline is meaningless now. Start
      // the watch again rather than graduating an index nobody ever checked.
      if (verdict === "UNOBSERVABLE") {
        await db
          .update(recommendations)
          .set({
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
          result: "write watch restarted: counters reset (server restarted) during the window",
        });
        continue;
      }
      // Graduation is checked only AFTER a real reading, so a window that
      // elapsed while we could not observe does not silently pass.
      if (now - rec.builtAt.getTime() >= observeDays * DAY_MS && verdict === "STABLE") {
        await db
          .update(recommendations)
          .set({ baselineWriteOps: null, baselineWriteLatency: null, updatedAt: new Date() })
          .where(eq(recommendations.id, rec.id));
        await retireSuperseded(db, clusterId, rec);
        continue;
      }
      if (verdict !== "REGRESSED") continue;
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
        const verdict = evaluateRegression(baseline, current, REGRESSION_OPTIONS);
        // Counters reset (the server restarted, typically while we could not
        // reach it): the window we thought we observed never happened. Put the
        // index back and re-propose — the drop is the one irreversible step, so
        // it does not get taken on evidence we no longer have. This also ends
        // the case where an index sat hidden through a long outage.
        if (verdict === "UNOBSERVABLE") {
          await executor.unhide(rec.database, rec.collection, rec.indexName);
          await db
            .update(recommendations)
            .set({
              state: "PROPOSED",
              hiddenAt: null,
              observeDays: null,
              baselineReadOps: null,
              baselineReadLatency: null,
              updatedAt: new Date(),
            })
            .where(eq(recommendations.id, rec.id));
          await db.insert(actions).values({
            recommendationId: rec.id,
            kind: "HIDE",
            actor: "system",
            result:
              "aborted + un-hidden: observation lost (counters reset — server restarted during the observe window)",
          });
          continue;
        }
        if (verdict === "REGRESSED") {
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

// The indexes a graduated CREATE/UPDATE/MERGE replaced.
//
// recommendCreates records them in targetSpec.retire, and until now nothing
// read it: UPDATE and MERGE built the replacement and left the originals to be
// re-discovered as DROP_REDUNDANT by a later classify pass. That works when the
// replacement is a strict superset and not otherwise — a partial replacement
// covers nothing (see analysis/redundancy.ts), so its originals would have sat
// there forever next to it.
//
// Retirement waits for graduation on purpose. Between build and graduation the
// new index may still be rolled back for slowing writes, and if it goes the
// originals have to still be there.
//
// They are PROPOSED, not dropped: same approval, same hide, same observe window
// and regression gate as any other drop. This only ensures the finding exists.
async function retireSuperseded(
  db: ReturnType<typeof jobDb>,
  clusterId: string,
  rec: { id: string; database: string; collection: string; indexName: string; targetSpec: unknown },
): Promise<void> {
  const target = rec.targetSpec;
  if (typeof target !== "object" || target === null) return;
  const retire: unknown = Reflect.get(target, "retire");
  if (!Array.isArray(retire)) return;
  const names = retire.filter((name): name is string => typeof name === "string");
  if (names.length === 0) return;

  for (const name of names) {
    // Nothing to do if a proposal for it already exists, or it is already on
    // its way out — classify may well have found it independently.
    const [existing] = await db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          eq(recommendations.database, rec.database),
          eq(recommendations.collection, rec.collection),
          eq(recommendations.indexName, name),
          inArray(recommendations.state, ["PROPOSED", "APPROVED", "HIDDEN"]),
        ),
      )
      .limit(1);
    if (existing !== undefined) continue;

    await db.insert(recommendations).values({
      clusterId,
      type: "DROP_REDUNDANT",
      state: "PROPOSED",
      database: rec.database,
      collection: rec.collection,
      indexName: name,
      rationale: `Superseded by ${rec.indexName}, which has now survived its post-build watch.`,
      score: SUPERSEDED_SCORE,
      estimatedBytesSaved: 0,
    });
    await db.insert(actions).values({
      recommendationId: rec.id,
      kind: "CREATE",
      actor: "system",
      result: `graduated; proposed retiring ${name}`,
    });
  }
}
