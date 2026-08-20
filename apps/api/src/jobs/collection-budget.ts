import { and, type Database, eq, inArray, LIVE_STATES, recommendations } from "../db";

// How many NET-NEW indexes are already on their way onto each collection (#281).
//
// Every guard in jobs/watched.ts is keyed on one INDEX, because that is what a
// collision is. The COST of an index is paid per COLLECTION — each write updates
// every index on it — so "is this index already spoken for" cannot answer "how
// many builds is this collection about to absorb", and nothing did.
//
// Counted as pending rather than only existing, which is the issue's second
// design question. The live index list a collect saw always understates what is
// coming: an APPROVED CREATE waits for the change window, which can be most of a
// day, and its index does not exist yet — so five builds approved across five
// passes each look like the first one.
//
// `target_spec.retire` is what makes a build net-new. An UPDATE widening an index
// and a MERGE folding several into one leave the collection carrying the same
// number or fewer, and charging those against a budget they are about to relieve
// would have the engine arguing against its own best move. REORDER is excluded by
// type: it rebuilds an index in place, retires the original through finalize
// rather than in its own row, and leaves the count where it started.
//
// Keyed `database collection`, matching how suggest groups its work.
export async function pendingBuildsByCollection(
  db: Database,
  clusterId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      database: recommendations.database,
      collection: recommendations.collection,
      targetSpec: recommendations.targetSpec,
    })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE"]),
        inArray(recommendations.state, [...LIVE_STATES]),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if ((row.targetSpec?.retire.length ?? 0) > 0) continue;
    const key = `${row.database} ${row.collection}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// The count a build has to answer for: what the collection carries now, what is
// already on the way, and this build itself.
//
// A function rather than three additions at the call site because the "+ 1" is
// the part that is easy to get wrong, and getting it wrong is invisible — it
// shifts every crowding penalty by one step and nothing fails.
export function collectionIndexesAfterBuild(
  existingIndexes: number,
  pendingBuilds: number,
): number {
  return existingIndexes + pendingBuilds + 1;
}

// Would this candidate be built WITHOUT anyone approving it, if the collection
// were not crowded? (#281)
//
// Five conditions, and pulling them out of the middle of suggest.ts is not
// tidying: combining them wrongly is what shipped. `heldFromInstant` was
// `crowded && !instant`, which counts a crowded candidate that nothing was going
// to build anyway — a read-only cluster, `instantCreate` off, a ROUTINE scan.
// The first real reading of it was `{"budget": 24}` on a read-only cluster,
// where the budget had decided nothing and read-only had decided everything.
//
// A feature whose whole purpose is reporting what the engine held back must not
// claim credit for what something else held back, so the predicate is named,
// separate from the crowding veto, and tested.
export interface UnattendedBuild {
  // Only a plain CREATE is ever built unattended. An UPDATE or MERGE retires
  // something, and a REORDER touches a protected index — both are approval-only.
  readonly type: string;
  // A scan is the only argument strong enough; an in-memory sort is not.
  readonly scanning: boolean;
  // The collection's measured scan cost. ROUTINE is not urgent enough to act on
  // without being asked.
  readonly severity: string;
  // Sightings of the shape, against the instant threshold.
  readonly count: number;
  readonly minCount: number;
  // The owner opted in, and the plan still permits it.
  readonly instantCreateEnabled: boolean;
  // A read-only cluster executes nothing at all, so nothing here is unattended.
  readonly readOnly: boolean;
}

export function wouldBuildUnattended(build: UnattendedBuild): boolean {
  return (
    build.type === "CREATE" &&
    build.scanning &&
    build.severity !== "ROUTINE" &&
    build.count >= build.minCount &&
    build.instantCreateEnabled &&
    !build.readOnly
  );
}
