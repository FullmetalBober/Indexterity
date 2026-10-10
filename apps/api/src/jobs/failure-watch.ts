import { describeShortBaseline, describeWatch, FAILURE_BASELINE_MS, utcMinute } from "../analysis";
import {
  actions,
  and,
  type Database,
  desc,
  eq,
  failureWatches,
  inArray,
  recommendations,
} from "../db";
import type {
  DatabaseWatch,
  EngineSession,
  FailedOpsReading,
  IndexCollector,
  WatchTarget,
} from "../engine/ports";
import { messageOf } from "../errors/message";

// The recommendation types apply.ts hides before it drops anything.
export const HIDE_TYPES: ReadonlySet<string> = new Set(["DROP_UNUSED", "DROP_REDUNDANT", "MERGE"]);

// Bring the cluster's failure watches in line with its drops in flight, and keep
// the list of watched databases in step with what the cluster says (#596).
//
// Wanted: every APPROVED drop (failures and hints, since it is not hidden yet)
// and every HIDDEN one (failures), in the databases being observed. Released:
// every database on the list that nothing wants any more — which is how a
// profiler gets back what it had once the last drop there graduates, is rolled
// back, or leaves the observed selection.
export async function keepFailureWatches(
  db: Database,
  clusterId: string,
  session: EngineSession,
  observedDatabases: readonly string[] | null,
): Promise<ReadonlyMap<string, DatabaseWatch>> {
  const watch = session.failureWatch;
  if (watch === null) return new Map();
  const inFlight = await db
    .select({
      database: recommendations.database,
      collection: recommendations.collection,
      indexName: recommendations.indexName,
      state: recommendations.state,
      type: recommendations.type,
    })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        inArray(recommendations.state, ["APPROVED", "HIDDEN"]),
      ),
    );
  const targets: WatchTarget[] = inFlight
    .filter((rec) => rec.state === "HIDDEN" || HIDE_TYPES.has(rec.type))
    .filter((rec) => observedDatabases === null || observedDatabases.includes(rec.database))
    .map((rec) => ({
      database: rec.database,
      collection: rec.collection,
      indexName: rec.indexName,
      beforeHide: rec.state === "APPROVED",
    }));
  const listed = await db
    .select({ database: failureWatches.database })
    .from(failureWatches)
    .where(eq(failureWatches.clusterId, clusterId));
  const wanted = new Set(targets.map((target) => target.database));
  const release = listed.map((row) => row.database).filter((name) => !wanted.has(name));
  const watches = await watch.reconcile(clusterId, targets, release);
  for (const [database, state] of watches) {
    if (state.ours) {
      await db.insert(failureWatches).values({ clusterId, database }).onConflictDoNothing();
    } else {
      await db
        .delete(failureWatches)
        .where(and(eq(failureWatches.clusterId, clusterId), eq(failureWatches.database, database)));
    }
  }
  return watches;
}

// Give back every profiler Indexterity turned on for this cluster, whatever is in
// flight — for a cluster turned read-only, and one being disconnected. Restoring
// is not a change the customer has to have opted into: the change was ours.
export async function releaseFailureWatches(
  db: Database,
  clusterId: string,
  session: EngineSession,
): Promise<void> {
  const watch = session.failureWatch;
  if (watch === null) return;
  const listed = await db
    .select({ database: failureWatches.database })
    .from(failureWatches)
    .where(eq(failureWatches.clusterId, clusterId));
  if (listed.length === 0) return;
  const watches = await watch.reconcile(
    clusterId,
    [],
    listed.map((row) => row.database),
  );
  for (const [database, state] of watches) {
    if (state.ours) continue;
    await db
      .delete(failureWatches)
      .where(and(eq(failureWatches.clusterId, clusterId), eq(failureWatches.database, database)));
  }
}

// keepFailureWatches for a pass that must go on without it. The watch is
// optional the way its source is (D131): a cluster it cannot be kept on still
// has its drops judged, rolled back and finished, so a failure here costs the
// watch — said once in the worker's log — and never the pass.
export async function keepFailureWatchesOrNone(
  db: Database,
  clusterId: string,
  session: EngineSession,
  observedDatabases: readonly string[] | null,
): Promise<ReadonlyMap<string, DatabaseWatch>> {
  try {
    return await keepFailureWatches(db, clusterId, session, observedDatabases);
  } catch (error) {
    console.warn(`failure watch: cluster ${clusterId} could not be kept — ${messageOf(error)}`);
    return new Map();
  }
}

// Approved drops the workload turned out to name with hint(), sent back to
// PROPOSED before they are hidden (#596). Returns their ids.
//
// Asked on every pass while a watch records hints, not only at the hide: the
// clause that records them also LOGS each such query — a filter decides the
// slow-query log as well as the profiler — so a candidate the application hints
// heavily is withdrawn within the hour rather than logged for a day.
export async function withdrawHinted(
  db: Database,
  clusterId: string,
  collector: IndexCollector,
  watches: ReadonlyMap<string, DatabaseWatch>,
): Promise<ReadonlySet<string>> {
  const withdrawn = new Set<string>();
  if (watches.size === 0) return withdrawn;
  const approved = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "APPROVED")));
  const hintsOn = new Map<string, Promise<readonly string[]>>();
  for (const rec of approved) {
    if (!HIDE_TYPES.has(rec.type) || watches.get(rec.database)?.kind !== "WATCHED") continue;
    const key = `${rec.database}\u0000${rec.collection}`;
    let hints = hintsOn.get(key);
    if (hints === undefined) {
      hints = collector.collectHintedIndexes(rec.database, rec.collection).catch(() => []);
      hintsOn.set(key, hints);
    }
    if (!(await hints).includes(rec.indexName)) continue;
    await db
      .update(recommendations)
      .set({ state: "PROPOSED", updatedAt: new Date() })
      .where(eq(recommendations.id, rec.id));
    await db.insert(actions).values({
      recommendationId: rec.id,
      kind: "HIDE",
      actor: "system",
      result:
        "aborted: the workload names this index with hint(), so hiding it would make those queries fail",
    });
    withdrawn.add(rec.id);
  }
  return withdrawn;
}

// When a drop on a watched namespace may be hidden: a day after its watch began
// (#596). Null where nothing has to be waited out — no watch of Indexterity's on
// the database, or a profiler there that records everything already, whose start
// reads as zero.
export function hideableAt(watch: DatabaseWatch | undefined, ns: string): number | null {
  if (watch?.kind !== "WATCHED") return null;
  return (watch.since.get(ns) ?? 0) + FAILURE_BASELINE_MS;
}

// Say why each approved drop has not been hidden yet, once per start of its watch
// (#630).
//
// It was said only when the watch began in the same apply pass. Apply arms
// nothing outside the change window, so a drop approved during the day had its
// watch started by finalize and then waited with an empty trail. A restart, which
// clears the profiler's settings and starts the watch over (D183), cost another
// day with nothing to show for it either. On production, five drops waiting
// "until 02:58" missed that night's window to a rolling restart at 12:45 the day
// before, and nothing anywhere said so. So both passes that keep the watch call
// this — finalize every hour, apply in the window — and a line is written whenever
// the trail does not already name the instant the drop is waiting for. A start
// the trail has reported before is said to have started over.
export async function noteWaitingDrops(
  db: Database,
  approved: readonly {
    readonly id: string;
    readonly type: string;
    readonly database: string;
    readonly collection: string;
  }[],
  watches: ReadonlyMap<string, DatabaseWatch>,
  now: number,
): Promise<void> {
  const waiting = approved.flatMap((rec) => {
    if (!HIDE_TYPES.has(rec.type)) return [];
    const at = hideableAt(watches.get(rec.database), `${rec.database}.${rec.collection}`);
    return at !== null && at > now ? [{ rec, since: at - FAILURE_BASELINE_MS }] : [];
  });
  if (waiting.length === 0) return;
  const last = new Map(
    (
      await db
        .selectDistinctOn([actions.recommendationId], {
          id: actions.recommendationId,
          result: actions.result,
        })
        .from(actions)
        .where(
          and(
            inArray(
              actions.recommendationId,
              waiting.map(({ rec }) => rec.id),
            ),
            eq(actions.kind, "HIDE"),
          ),
        )
        .orderBy(actions.recommendationId, desc(actions.createdAt))
    ).map((row) => [row.id, row.result]),
  );
  for (const { rec, since } of waiting) {
    const previous = last.get(rec.id);
    if (previous?.includes(`until ${utcMinute(since + FAILURE_BASELINE_MS)}`) === true) continue;
    await db.insert(actions).values({
      recommendationId: rec.id,
      kind: "HIDE",
      actor: "system",
      result:
        previous?.startsWith("waiting") === true
          ? waitingAgainLine(rec.database, rec.collection, since)
          : waitingLine(rec.database, rec.collection, since),
    });
  }
}

// The audit line of a drop waiting out its baseline, written when the watch begins.
export function waitingLine(database: string, collection: string, since: number): string {
  return (
    `waiting: recording failed operations on ${database}.${collection} until ` +
    `${utcMinute(since + FAILURE_BASELINE_MS)} before hiding, so a failure after the hide has a ` +
    "day to be compared against — Indexterity turned the profiler on for it"
  );
}

// The same line when the watch had started before and started over: the
// profiler's settings are gone, which is what a restart does (D183, #630).
export function waitingAgainLine(database: string, collection: string, since: number): string {
  return (
    `waiting again: the record of failed operations on ${database}.${collection} started over at ` +
    `${utcMinute(since)}, as it does when a server restarts and its profiler loses Indexterity's ` +
    `settings, so the hide waits until ${utcMinute(since + FAILURE_BASELINE_MS)} for a day to ` +
    "compare against"
  );
}

// The failed-operations clause of a HIDE line: what the check will see, and —
// where Indexterity could not turn the source on — why not, which is the part an
// owner can do something about. And when what can be read before the hide is
// short of a day, what that leaves the check able to act on (#625).
export function watchLine(
  reading: FailedOpsReading,
  watch: DatabaseWatch | undefined,
  hiddenAtMs: number,
): string {
  const seen = describeWatch(reading);
  const short = describeShortBaseline(reading, hiddenAtMs);
  let line = seen;
  if (watch?.kind === "UNWATCHED" && seen !== "") line = `${seen}; ${watch.reason}`;
  else if (watch?.kind === "WATCHED" && watch.ours && seen === "" && reading.kind === "WINDOW") {
    line = `failed operations watched since ${utcMinute(reading.reachMs)}, by the profiler Indexterity turned on`;
  }
  if (short === "") return line;
  return line === "" ? short : `${line} — ${short}`;
}
