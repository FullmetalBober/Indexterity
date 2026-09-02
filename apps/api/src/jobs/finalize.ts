import {
  DEFAULT_OBSERVE_DAYS,
  describeFailures,
  evaluateRegression,
  type FailureVerdict,
  inChangeWindow,
  judgeFailures,
  type LatencyReading,
  latencyRatio,
  OBSERVE_WALLCLOCK_MULTIPLE,
  observedWindow,
  oldestLiveBaseline,
  outstayedWindow,
  runFrom,
} from "../analysis";
import type { Database } from "../db";
import {
  actions,
  and,
  eq,
  gte,
  inArray,
  latencySamples,
  policies,
  recommendations,
  roiMetrics,
} from "../db";
import { emitClusterEvent, pgNotifier } from "../events/emit";
import { NotifyService } from "../mail/notify.service";
import { recordDrop, recordRegressionVerdict } from "../metrics";
import { serializeSpec } from "../mongo";
import type { TunnelRegistry } from "../tunnel/tunnel.registry";
import { effectiveChangeWindow } from "./change-window";
import { openClusterSession } from "./cluster-connection";
import { recordRegression, WHOLE_COLLECTION } from "./cooldowns";
import { preflightDrop } from "./preflight";

const DAY_MS = 86_400_000;
// Both per-index gates — did hiding this index slow reads, did building it slow
// writes — are measured over stored history now (analysis/observed.ts), so the
// options they read live here rather than in a pair that could disagree. Same
// numbers the cumulative baseline gate used: the mechanism changed because a
// restart broke it, and moving the threshold in the same change would make the
// two impossible to tell apart.
const OBSERVED_OPTIONS = { factor: 1.5, minWindowOps: 20 };
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

// This collection's stored latency readings, back far enough to hold both halves
// of the observe comparison: the window itself, and the same length of history
// before the hide to compare it against.
//
// A read per hidden row rather than one per collect, because the set of hidden
// rows is small — the collection budget and the one-live-claim constraint both
// bound it — and a join would tie this gate to the shape of the insights read.
async function collectionLatencyHistory(
  db: Database,
  clusterId: string,
  database: string,
  collection: string,
  since: Date,
): Promise<LatencyReading[]> {
  const rows = await db
    .select()
    .from(latencySamples)
    .where(
      and(
        eq(latencySamples.clusterId, clusterId),
        eq(latencySamples.database, database),
        eq(latencySamples.collection, collection),
        gte(latencySamples.lastSeenAt, since),
      ),
    );
  return rows.map((row) => ({
    ...runFrom(row),
    readOps: row.readOps,
    readLatencyMicros: row.readLatencyMicros,
    writeOps: row.writeOps,
    writeLatencyMicros: row.writeLatencyMicros,
  }));
}

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
  // Every hidden row is examined on every pass, and OBSERVED time decides
  // whether it has waited long enough — not elapsed wall clock.
  //
  // Those were the same number while a restart aborted the window. They are not
  // now: `observedWindow` sums the stretches that produced a reading and skips
  // the one a reset landed in, so a cluster that restarts nightly accumulates
  // its 30 days a little slower than the calendar rather than never. Filtering
  // on wall clock here would have let a row become "due" with most of its window
  // unmeasured, which is the reading the gate below exists to refuse.
  const due = hiddenRecs.filter((rec) => rec.hiddenAt !== null);
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
      const builtAtMs = rec.builtAt.getTime();
      // Measured the same way the drop side measures its window (#394): summed
      // over the stretches of stored history a restart did not eat, rather than
      // differenced against the baseline on this row.
      //
      // That baseline used to be the whole watch, and a restart voided it — so
      // the watch went back to zero, `builtAt` with it, and on a cluster that
      // restarts oftener than the window it could never reach the end. Nothing
      // was executed wrongly; the index simply never GRADUATED, which is the
      // event that retires the originals it superseded, runs the cumulative
      // check, and releases the index from the watched guard. A correct finding
      // that is never made, and it compounds — every un-graduated build leaves a
      // row that suppresses its own index.
      const history = await collectionLatencyHistory(
        db,
        clusterId,
        rec.database,
        rec.collection,
        new Date(builtAtMs - observeDays * DAY_MS),
      );
      const observed = observedWindow(history, "write", builtAtMs, observeDays, {
        ...OBSERVED_OPTIONS,
        recordedBaselineMicrosPerOp:
          rec.baselineWriteOps > 0 ? rec.baselineWriteLatency / rec.baselineWriteOps : undefined,
      });
      recordRegressionVerdict("post_build", observed.verdict);
      const verdict = observed.verdict;
      // Still watching. Unlike the drop side there is nothing to undo by giving
      // up — the index is built and serving either way — so past the cap the
      // watch CONCLUDES on what it managed to measure instead of un-doing
      // anything. Leaving it open is the worse option and the one that shipped:
      // it withholds the retirement and suppresses the index indefinitely, on a
      // collection quiet enough that nothing could have been measured anyway.
      const undecided = verdict === "INCOMPLETE" || verdict === "NO_BASELINE";
      if (undecided && !outstayedWindow(builtAtMs, observeDays, now)) continue;
      if (undecided) {
        await db.insert(actions).values({
          recommendationId: rec.id,
          kind: "CREATE",
          actor: "system",
          result: `write watch cut short: only ${Math.round(observed.observedMs / DAY_MS)} of ${observeDays} days could be measured in ${OBSERVE_WALLCLOCK_MULTIPLE}× the window`,
        });
      }
      // Everything that is not a regression graduates: measured and fine, too
      // quiet to have been hurt, or — past the cap — as much of the window as
      // this collection was ever going to give. Never on elapsed time alone,
      // which is what the observation count above replaces.
      if (verdict !== "REGRESSED") {
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
        await emitClusterEvent(pgNotifier(db), { clusterId, kind: "BUILD_GRADUATED", task: null });
        continue;
      }
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
      await emitClusterEvent(pgNotifier(db), { clusterId, kind: "REGRESSION_FIRED", task: null });
    }
    for (const rec of due) {
      // Regression gate: did hiding this index slow the collection's reads
      // during observe? If so, un-hide and re-propose instead of dropping.
      //
      // Read off `latency_samples` rather than a baseline this row carries, so a
      // restart costs the window it lands in instead of the whole observation —
      // see analysis/observed.ts for why re-baselining the old way could not
      // work. The row's own baseline columns are what the hide RECORDED and are
      // left alone; nothing decides on them any more.
      // The row's own baseline columns still decide WHETHER a read-latency
      // measurement is owed — apply.ts records them exactly when the index was
      // really hidden, and an engine that cannot hide records neither. Only HOW
      // the measurement is taken has changed.
      // What the error side of the window saw, carried out of the block below so the
      // graduating drop can record it. UNAVAILABLE until something asks (#438).
      let failures: FailureVerdict = { kind: "UNAVAILABLE" };
      if (
        rec.hiddenAt !== null &&
        rec.baselineReadOps !== null &&
        rec.baselineReadLatency !== null
      ) {
        const hiddenAtMs = rec.hiddenAt.getTime();
        const days = rec.observeDays ?? observeDays;
        // Errors before latency, and before anything can graduate on the strength of
        // them (#438). A hide that broke its queries is an OUTAGE, so it must not wait
        // for the observation window to fill the way a slowdown does — and the latency
        // gate below cannot see it at all, because a failed read is a fast read.
        //
        // One-way: this can turn a graduation into a rollback and never the reverse.
        // Every source is optional and PostgreSQL has none, so a gate that demanded
        // the signal would refuse every drop on every cluster that cannot supply it.
        failures = judgeFailures(
          rec.baselineFailedOps === null
            ? null
            : { failed: rec.baselineFailedOps, reachMs: rec.baselineFailedReachMs ?? 0 },
          await collector.collectFailedOps(rec.database, rec.collection, hiddenAtMs),
        );
        if (failures.kind === "INTRODUCED") {
          await executor.unhide(rec.database, rec.collection, rec.indexName);
          const until = await recordRegression(
            db,
            clusterId,
            { database: rec.database, collection: rec.collection, indexName: rec.indexName },
            observeDays,
            "failed operations during observe",
          );
          const day = until.toISOString().slice(0, 10);
          await db
            .update(recommendations)
            .set({
              state: "REJECTED",
              hiddenAt: null,
              rationale: `${rec.rationale} — auto-rejected: queries began failing while it was hidden; cooling down until ${day}`,
              updatedAt: new Date(),
            })
            .where(eq(recommendations.id, rec.id));
          await db.insert(actions).values({
            recommendationId: rec.id,
            kind: "DROP",
            actor: "system",
            result: `aborted + cooldown until ${day}: ${describeFailures(failures)}`,
          });
          await new NotifyService(db).notifyClusterOwners(
            clusterId,
            `kept ${rec.indexName} (queries failing)`,
            `Queries on ${rec.database}.${rec.collection} started FAILING while ${rec.indexName} was hidden — ${failures.failed} of them, where none were failing before. The index has been un-hidden and the drop aborted; it is cooling down until ${day}. This is the case a latency check cannot catch, because a query that fails returns faster than one that works.`,
          );
          await emitClusterEvent(pgNotifier(db), {
            clusterId,
            kind: "REGRESSION_FIRED",
            task: null,
          });
          continue;
        }
        // Two windows back: the observation, and the reference before it. The
        // wall-clock cap bounds how long the first can take, so this is the
        // furthest back either half can reach.
        const readings = await collectionLatencyHistory(
          db,
          clusterId,
          rec.database,
          rec.collection,
          new Date(hiddenAtMs - days * DAY_MS),
        );
        const observed = observedWindow(readings, "read", hiddenAtMs, days, {
          ...OBSERVED_OPTIONS,
          // What the hide measured, as the reference of last resort.
          recordedBaselineMicrosPerOp:
            rec.baselineReadOps > 0 ? rec.baselineReadLatency / rec.baselineReadOps : undefined,
        });
        recordRegressionVerdict("observe", observed.verdict);
        // Hidden far longer than the observation was worth. A collection blind
        // enough that its window never fills is one we cannot judge, and waiting
        // it out costs somebody a hidden index indefinitely — so the index goes
        // back and the finding is re-proposed rather than quietly abandoned.
        // classify.ts declines to propose a drop it can already see hitting this,
        // so reaching it means the cluster got worse after the proposal was made.
        const undecided = observed.verdict === "INCOMPLETE" || observed.verdict === "NO_BASELINE";
        if (undecided && outstayedWindow(hiddenAtMs, days, now)) {
          await executor.unhide(rec.database, rec.collection, rec.indexName);
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
            result: `aborted + un-hidden: only ${Math.round(observed.observedMs / DAY_MS)} of ${days} days could be measured in ${OBSERVE_WALLCLOCK_MULTIPLE}× the window`,
          });
          continue;
        }
        // Still accumulating, or nothing from before the hide to compare against.
        // Neither is a verdict, and the index stays hidden and keeps observing —
        // NO_BASELINE resolves as soon as one clean pre-hide window is retained,
        // and the cap above is what stops either waiting forever.
        if (undecided) continue;
        if (observed.verdict === "REGRESSED") {
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
          await new NotifyService(db).notifyClusterOwners(
            clusterId,
            `kept ${rec.indexName} (regression)`,
            canHide
              ? `Hiding ${rec.indexName} on ${rec.database}.${rec.collection} slowed reads during the observe window, so the drop was aborted and the index un-hidden. It is cooling down until ${day}.`
              : `Reads on ${rec.database}.${rec.collection} slowed during ${rec.indexName}'s observe window, so the drop was aborted. The index was never hidden, so nothing had to be restored. It is cooling down until ${day}.`,
          );
          await emitClusterEvent(pgNotifier(db), {
            clusterId,
            kind: "REGRESSION_FIRED",
            task: null,
          });
          continue;
        }
      } else if (
        rec.hiddenAt !== null &&
        now - rec.hiddenAt.getTime() < (rec.observeDays ?? observeDays) * DAY_MS
      ) {
        // An engine with no reversible hide (cluster-connection.ts). Nothing was
        // hidden, so there is no read-latency question to ask and no observation
        // to accumulate — elapsed wall clock is the only clock this case ever
        // had, and the evidence for the drop is the usage counters staying flat,
        // which preflightDrop re-checks below.
        continue;
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
        // Named even when it found nothing, and especially when it could not look: a
        // gate that ran and cleared the drop must not read the same in the audit
        // trail as a gate that never ran (D19).
        result: `ok — ${describeFailures(failures)}`,
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
  const names = retire.filter((name) => typeof name === "string");
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
  // meaningless.
  //
  // The one comparison still made this way, and the reason it may stay: the
  // per-index watches moved to stored history because a reset made them refuse
  // FOREVER on a restarting cluster, and the response there was destructive
  // either way round. This one only ever reports, and a chain spanning several
  // builds is a different measurement from the windows `observedWindow` sums —
  // so on a cluster that restarts oftener than a run of builds takes, the
  // cumulative reading stays silent. Smaller residual, non-destructive, and not
  // worth a second mechanism until somebody is missing the finding.
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
  await emitClusterEvent(pgNotifier(db), { clusterId, kind: "REGRESSION_FIRED", task: null });
}
