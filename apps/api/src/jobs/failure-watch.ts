import { describeShortBaseline, describeWatch, FAILURE_BASELINE_MS, utcMinute } from "../analysis";
import { actions, and, type Database, eq, failureWatches, inArray, recommendations } from "../db";
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

// The audit line of a drop waiting out its baseline, written when the watch begins.
export function waitingLine(database: string, collection: string, since: number): string {
  return (
    `waiting: recording failed operations on ${database}.${collection} until ` +
    `${utcMinute(since + FAILURE_BASELINE_MS)} before hiding, so a failure after the hide has a ` +
    "day to be compared against — Indexterity turned the profiler on for it"
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
