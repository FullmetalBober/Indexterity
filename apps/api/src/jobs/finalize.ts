import {
  DEFAULT_OBSERVE_DAYS,
  evaluateRegression,
  inChangeWindow,
  latencyRatio,
  oldestLiveBaseline,
} from "../analysis";
import type { Database } from "../db";
import { actions, and, eq, inArray, policies, recommendations, roiMetrics } from "../db";
import { emitClusterEvent } from "../events/emit";
import { NotifyService } from "../mail/notify.service";
import { recordDrop, recordRegressionVerdict } from "../metrics";
import { serializeSpec } from "../mongo";
import type { TunnelRegistry } from "../tunnel/tunnel.registry";
import { effectiveChangeWindow } from "./change-window";
import { openClusterSession } from "./cluster-connection";
import { recordRegression, WHOLE_COLLECTION } from "./cooldowns";
import { preflightDrop } from "./preflight";

const DAY_MS = 86_400_000;
const REGRESSION_OPTIONS = { factor: 1.5, minWindowOps: 20 };
// The same measurement asked of the COLLECTION rather than of one index (#282),
// and it gets its own factor because it is a different question.
//
// 1.5x against one index is a strong per-index claim: this index, on its own,
// made writes half again slower. 1.5x against a run of three is a much weaker
// per-index claim and a much stronger collection-level one — the collection is
// half again slower and no single build did it. So the bar is lower, and what
// licenses lowering it is that the response is not destructive: nothing is rolled
// back on this verdict, the collection is parked from UNATTENDED builds and the
// owners are told. 1.3 catches the shape the issue describes — three defensible
// 15% builds land near 1.52 cumulatively and near 1.15 individually — with
// margin, where 1.5 would have caught it by two points.
const CUMULATIVE_REGRESSION_OPTIONS = { factor: 1.3, minWindowOps: 20 };
// A superseded index is a structural finding backed by a replacement that has
// already proven itself, so it scores like any other redundancy.
const SUPERSEDED_SCORE = 55;

// HIDDEN drops whose observe window has elapsed -> pre-flight -> drop -> DROPPED.
// The drop is the only irreversible step. A failed pre-flight during observe
// un-hides the index and re-proposes it (the reversible safety path). Freed
// bytes are recorded to roi_metrics for the dashboard headline.
export async function finalizeCluster(
  db: Database,
  clusterId: string,
  // The live tunnels, when this cluster is reached over one (#353).
  // Optional because most callers have none and every cluster before
  // #353 needs none; a cluster WITH a tunnel_id and no registry is
  // refused rather than dialled directly.
  tunnels?: TunnelRegistry,
): Promise<number> {
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
        inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE", "REORDER"]),
      ),
    );
  if (due.length === 0 && watched.length === 0) return 0;

  const { session, readOnly, canHide, release } = await openClusterSession(db, clusterId, {
    tunnels,
  });
  try {
    // Read-only clusters never execute writes.
    if (readOnly) return 0;
    const collector = session.collector;
    const executor = session.executor(readOnly);
    let dropped = 0;
    let freedBytes = 0;

    // Collections this pass has already reported a cumulative regression for
    // (#282). Several builds on one collection can come due in the same pass, and
    // each would compare against the same oldest baseline and reach the same
    // conclusion — one event, recorded as two, escalating the cooldown as though
    // the collection had regressed twice.
    const reportedCumulative = new Set<string>();

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
      recordRegressionVerdict("post_build", verdict);
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
        // Before the baselines are cleared, ask the question this row cannot:
        // has the whole RUN of builds slowed the collection, even though this one
        // did not? (#282) The oldest baseline still live for the collection is
        // "before the run started", and clearing them below is what ends the
        // chain — so this is the last moment it can be asked.
        await judgeCumulative(db, clusterId, rec, watched, writes, observeDays, reportedCumulative);
        await db
          .update(recommendations)
          .set({ baselineWriteOps: null, baselineWriteLatency: null, updatedAt: new Date() })
          .where(eq(recommendations.id, rec.id));
        await retireSuperseded(db, clusterId, rec);
        await emitClusterEvent(db, { clusterId, kind: "BUILD_GRADUATED", task: null });
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
      await new NotifyService(db).notifyClusterOwners(
        clusterId,
        `rolled back ${rec.indexName}`,
        `The index ${rec.indexName} on ${rec.database}.${rec.collection} slowed writes after being built, so it was dropped automatically. It is cooling down until ${day}.`,
      );
      await emitClusterEvent(db, { clusterId, kind: "REGRESSION_FIRED", task: null });
    }
    for (const rec of due) {
      // Regression gate: did hiding this index slow the collection's reads
      // during observe? If so, un-hide and re-propose instead of dropping.
      if (rec.baselineReadOps !== null && rec.baselineReadLatency !== null) {
        const current = await collector.readLatency(rec.database, rec.collection);
        const baseline = { ops: rec.baselineReadOps, latencyMicros: rec.baselineReadLatency };
        const verdict = evaluateRegression(baseline, current, REGRESSION_OPTIONS);
        recordRegressionVerdict("observe", verdict);
        // Counters reset (the server restarted, typically while we could not
        // reach it): the window we thought we observed never happened. Put the
        // index back and re-propose — the drop is the one irreversible step, so
        // it does not get taken on evidence we no longer have. This also ends
        // the case where an index sat hidden through a long outage.
        if (verdict === "UNOBSERVABLE") {
          if (canHide) await executor.unhide(rec.database, rec.collection, rec.indexName);
          await db
            .update(recommendations)
            .set({
              state: "PROPOSED",
              hiddenAt: null,
              observeDays: null,
              observeReason: null,
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
          if (canHide) await executor.unhide(rec.database, rec.collection, rec.indexName);
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
          await new NotifyService(db).notifyClusterOwners(
            clusterId,
            `kept ${rec.indexName} (regression)`,
            canHide
              ? `Hiding ${rec.indexName} on ${rec.database}.${rec.collection} slowed reads during the observe window, so the drop was aborted and the index un-hidden. It is cooling down until ${day}.`
              : `Reads on ${rec.database}.${rec.collection} slowed during ${rec.indexName}'s observe window, so the drop was aborted. The index was never hidden, so nothing had to be restored. It is cooling down until ${day}.`,
          );
          await emitClusterEvent(db, { clusterId, kind: "REGRESSION_FIRED", task: null });
          continue;
        }
      }
      // The regression gate above ran (safety); the drop itself waits for the
      // change window — the index simply stays hidden until a tick inside it.
      if (!windowOpen) continue;
      const check = await preflightDrop(collector, rec);
      if (!check.safe) {
        if (check.spec !== null) {
          // The one un-hide on this path that a no-hide engine actually reaches:
          // the two above sit behind a read-latency baseline, which apply.ts only
          // records when the index was really hidden.
          if (canHide) await executor.unhide(rec.database, rec.collection, rec.indexName);
          recordDrop("unhidden");
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
          recordDrop("absent");
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
      // After the executor, not before: this counter is the audit of what
      // actually happened on the cluster, so a drop that threw must not be in it.
      recordDrop("dropped");
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
      await new NotifyService(db).notifyClusterOwners(
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
  db: Database,
  clusterId: string,
  rec: {
    id: string;
    type: string;
    database: string;
    collection: string;
    indexName: string;
    targetSpec: unknown;
  },
): Promise<void> {
  const target = rec.targetSpec;
  if (typeof target !== "object" || target === null) return;
  const retire: unknown = Reflect.get(target, "retire");
  if (!Array.isArray(retire)) return;
  const names = retire.filter((name): name is string => typeof name === "string");
  if (names.length === 0) return;
  // A REORDER retires a PROTECTED index, which every other drop path refuses on
  // sight. The row therefore names what replaced it, and preflightDrop re-checks
  // that claim against LIVE state before the drop: same key set, same options,
  // present and not hidden. Naming it here rather than trusting the type is what
  // keeps the exemption tied to a specific replacement instead of widening
  // isNeverDrop for a whole class of rows.
  const supersededBy = rec.type === "REORDER" ? { supersededBy: rec.indexName } : {};

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

    // onConflictDoNothing against recommendations_one_live_claim, and the
    // insert's own answer decides whether there is anything to record (#283).
    // The select above is this producer's guard and it is broader than the
    // constraint — a live BUILD on this name holds the retirement back too —
    // but it is a read followed by a write, and classify runs on its own queue.
    // Filing an action for a row that never landed would put a retirement in the
    // audit trail that nothing on the dashboard can show.
    const [proposed] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_REDUNDANT",
        state: "PROPOSED",
        // Nothing re-derives this one. Where a MERGE leaves a strict superset
        // that classify would rediscover on its own, a narrowing leaves the
        // opposite: next to {a,b}, the index that looks redundant is {a,b} — so
        // if a sweep takes this row, the long index stays forever.
        source: "RETIRE",
        database: rec.database,
        collection: rec.collection,
        indexName: name,
        rationale:
          rec.type === "REORDER"
            ? `Superseded by ${rec.indexName}, which carries the same keys in the same order with ` +
              `the directions the workload needs, and the same options — including the unique ` +
              `constraint, which it has been enforcing alongside this one since it was built. It ` +
              `has now survived its post-build watch, so this one is no longer doing anything the ` +
              `replacement is not.`
            : `Superseded by ${rec.indexName}, which has now survived its post-build watch.`,
        score: SUPERSEDED_SCORE,
        estimatedBytesSaved: 0,
        ...(Object.keys(supersededBy).length === 0
          ? {}
          : { targetSpec: { keys: [], retire: [], ...supersededBy } }),
      })
      .onConflictDoNothing()
      .returning({ id: recommendations.id });
    if (proposed === undefined) continue;
    await db.insert(actions).values({
      recommendationId: rec.id,
      kind: "CREATE",
      actor: "system",
      result: `graduated; proposed retiring ${name}`,
    });
  }
}

// Did the whole RUN of builds slow this collection, even though the one just
// graduating did not? (#282)
//
// The post-build watch takes each index's baseline at that index's own build
// time, so build #2 is measured against a collection already carrying #1 and #3
// against one carrying both. Every comparison is against the immediately
// preceding state, never against the original — which is the right question for
// "did THIS index slow writes" and not the question an owner has, which is "did
// the last month of changes slow my writes". Three builds that each add a
// defensible 15% are three STABLE verdicts and a collection half again slower.
//
// Nothing new is stored to answer it. Every un-graduated build on the collection
// carries its own `baselineWriteOps`/`baselineWriteLatency` and a `builtAt`, and
// graduation clears them, so the oldest row still holding one is the reading from
// before this run of changes and the chain empties itself as the run ends.
//
// WHAT IT DOES NOT DO: roll anything back. The newest index is the obvious thing
// to undo and is not obviously the culprit — it may be the most valuable of the
// three, and the first may be the one that cost the writes. Attribution needs
// evidence this does not have, so the conservative version is the one that
// needed no attribution: say so, and stop building on this collection unattended
// until someone has looked.
//
// WHAT IT CANNOT SEE: an accumulation spread over months. Once every build on a
// collection graduates, the chain is empty and the next build starts fresh —
// correct, and it means only a RUN is measured. Catching the slow version needs a
// collection-level baseline refreshed on a schedule, which is a new thing to
// store and a separate decision.
async function judgeCumulative(
  db: Database,
  clusterId: string,
  rec: typeof recommendations.$inferSelect,
  watched: readonly (typeof recommendations.$inferSelect)[],
  current: { ops: number; latencyMicros: number },
  observeDays: number,
  // Collections already reported in this pass — see the call site.
  reported: Set<string>,
): Promise<void> {
  const namespace = `${rec.database}.${rec.collection}`;
  if (reported.has(namespace)) return;
  // From the snapshot `watched` took at the start of the pass, deliberately: a
  // sibling that graduated earlier in this same loop has had its baselines
  // cleared in the database by now, and it is still part of the run this one is
  // being measured against.
  const chain = watched.flatMap((row) =>
    row.database === rec.database &&
    row.collection === rec.collection &&
    row.builtAt !== null &&
    row.baselineWriteOps !== null &&
    row.baselineWriteLatency !== null
      ? [
          {
            builtAt: row.builtAt,
            baseline: { ops: row.baselineWriteOps, latencyMicros: row.baselineWriteLatency },
          },
        ]
      : [],
  );
  const oldest = oldestLiveBaseline(chain);
  // Nothing to add when this row IS the oldest: the cumulative comparison is
  // then the individual one, which has already been made and reported.
  if (oldest === null || oldest.builtAt.getTime() >= (rec.builtAt?.getTime() ?? 0)) return;

  const verdict = evaluateRegression(oldest.baseline, current, CUMULATIVE_REGRESSION_OPTIONS);
  recordRegressionVerdict("cumulative", verdict);
  // Marked whatever the verdict: the reading is the collection's, so a second row
  // graduating in this pass would ask the identical question of the identical
  // numbers.
  reported.add(namespace);
  // UNOBSERVABLE answers the reset question (#282's fourth) without a rule of its
  // own: a counter below the oldest baseline means the server restarted since it
  // was taken, so the chain spans a reset and the arithmetic across it is
  // meaningless. The individual watch re-baselines on the same signal.
  if (verdict !== "REGRESSED") return;

  const ratio = latencyRatio(oldest.baseline, current, CUMULATIVE_REGRESSION_OPTIONS.minWindowOps);
  const slower = ratio === null ? "measurably" : `${Math.round((ratio - 1) * 100)}%`;
  const since = oldest.builtAt.toISOString().slice(0, 10);
  const reason = `writes ${slower} slower than before the run of builds that began ${since}`;
  // Parked on the COLLECTION, which is the unit the cost is paid in — see
  // cooldowns.ts for why the sentinel is the empty index name. It escalates and
  // fades on the same clock as every other cooldown, so a collection this happens
  // to twice is parked twice as long.
  const until = await recordRegression(
    db,
    clusterId,
    { database: rec.database, collection: rec.collection, indexName: WHOLE_COLLECTION },
    observeDays,
    reason,
  );
  const day = until.toISOString().slice(0, 10);
  await db.insert(actions).values({
    recommendationId: rec.id,
    kind: "CREATE",
    actor: "system",
    result: `graduated, but ${reason} — ${rec.database}.${rec.collection} will not be built on unattended until ${day}`,
  });
  await new NotifyService(db).notifyClusterOwners(
    clusterId,
    `${rec.database}.${rec.collection} is slower to write than before`,
    `Each index built on ${rec.database}.${rec.collection} passed its own post-build check, and ` +
      `together they have not: the collection's writes are ${slower} slower than before the run ` +
      `of builds that began ${since}. Every write to a collection updates every index on it, so ` +
      `several individually reasonable indexes can add up to a cost none of them shows on its ` +
      `own.\n\nNothing has been rolled back — the newest index is not necessarily the one ` +
      `costing you, and undoing the wrong one would be worse than telling you. Indexterity will ` +
      `not build on this collection unattended until ${day}; recommendations for it keep ` +
      `arriving and you can approve them yourself.`,
  );
  await emitClusterEvent(db, { clusterId, kind: "REGRESSION_FIRED", task: null });
}
