import { and, type Database, eq, inArray, ne, or, recommendations } from "../db";

const DAY_MS = 86_400_000;

// NUL-separated, matching how classify groups snapshots: a collection or index
// name can contain a space, so a space-joined key could collide.
export function watchKey(database: string, collection: string, indexName: string): string {
  return [database, collection, indexName].join("\u0000");
}

// Indexes the engine itself put there and is still judging.
//
// A built index starts a post-build write watch that runs for the observe
// window: does it slow this collection's writes enough to be worth undoing?
// Meanwhile the usage side needs only three snapshots — eighteen hours at the
// 6h collect cadence — before it will call a quiet index dead. Without this,
// an index built for a query shape that then went quiet gets proposed for
// DROP_UNUSED on day one of a thirty-day watch: the engine arguing with itself,
// in two rows on the same dashboard.
//
// Covered here:
//   APPROVED - the build is queued or in flight; the index may already exist.
//   ACTIVE   - built, and either still inside its watch window or still
//              carrying write baselines (a watch that re-based after a server
//              restart runs past the original window).
//
// Not covered: a graduated index. Once its watch has passed and its baselines
// are cleared, it is an ordinary index and answers to the same rules as one the
// customer built.
export async function watchedIndexKeys(
  db: Database,
  clusterId: string,
  observeDays: number,
  now: Date = new Date(),
): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE", "REORDER"]),
        inArray(recommendations.state, ["APPROVED", "ACTIVE"]),
      ),
    );

  const keys = new Set<string>();
  for (const row of rows) {
    const stillWatched =
      row.state === "APPROVED" ||
      row.baselineWriteOps !== null ||
      (row.builtAt !== null && now.getTime() - row.builtAt.getTime() < observeDays * DAY_MS);
    if (stillWatched) keys.add(watchKey(row.database, row.collection, row.indexName));
  }
  return keys;
}

// Indexes with a drop already on the way: proposed, approved, or hidden and
// waiting out its observe window.
//
// They still exist on the cluster, so they stay in the classify inputs — but
// they must not be the reason another index is dropped. "Covered by X" stops
// being true the moment X leaves, and without this two indexes can cover each
// other out of existence: narrowing {a,b,c} to {a,b} builds the shorter one,
// and until the longer is actually gone it makes the new one look redundant.
export async function pendingRemovalKeys(db: Database, clusterId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      database: recommendations.database,
      collection: recommendations.collection,
      indexName: recommendations.indexName,
    })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        inArray(recommendations.type, ["DROP_UNUSED", "DROP_REDUNDANT"]),
        inArray(recommendations.state, ["PROPOSED", "APPROVED", "HIDDEN"]),
      ),
    );
  return new Set(rows.map((row) => watchKey(row.database, row.collection, row.indexName)));
}

// Types that make the same claim about one index, for the purpose of "is there
// already a live recommendation saying this?". A DROP_UNUSED and a
// DROP_REDUNDANT both mean "this index should go", so one standing beside the
// other is a duplicate however differently they got there.
export const DROP_TYPES = ["DROP_UNUSED", "DROP_REDUNDANT"] as const;
export const BUILD_TYPES = ["CREATE", "UPDATE", "MERGE", "REORDER"] as const;

// States a recommendation can be in while it is still going somewhere. DROPPED,
// ACTIVE, REJECTED and ROLLED_BACK are settled: the work happened or it will
// not, and re-deriving the finding is then correct rather than duplicative —
// classify is supposed to be able to propose dropping an index a graduated
// build put there, and a REJECTED drop is held off by a cooldown instead.
const LIVE_STATES = ["PROPOSED", "APPROVED", "HIDDEN", "OBSERVE", "SCHEDULED", "BUILDING"] as const;

// Indexes that already carry a live recommendation of one of `types` which this
// caller's own sweep will NOT delete.
//
// classify and suggest both rewrite their PROPOSED rows from scratch on every
// pass: delete everything this source proposed, re-derive, insert. That is only
// self-consistent for rows still in PROPOSED. The moment a customer approves
// one, it leaves the set the sweep clears — while the index it names is still
// sitting on the cluster, still looking exactly as droppable as it did before —
// so the next pass proposes it again and the dashboard shows the same finding
// twice, once APPROVED and once awaiting approval. Approving the second one
// queues a second drop of an index the first one is already taking away.
//
// Same shape for a build: an APPROVED CREATE waits for the change window, which
// can be most of a day, and the index it would build does not exist yet — so
// nothing in the live index list stops suggest re-proposing it meanwhile.
//
// `ownSource` is the caller's own producer tag: its PROPOSED rows are about to
// be deleted, so they must not suppress the finding that replaces them. Every
// other row here outlives the sweep and would sit beside it.
export async function standingRecommendationKeys(
  db: Database,
  clusterId: string,
  types: readonly (typeof recommendations.$inferSelect)["type"][],
  ownSource: (typeof recommendations.$inferSelect)["source"],
): Promise<Set<string>> {
  const rows = await db
    .select({
      database: recommendations.database,
      collection: recommendations.collection,
      indexName: recommendations.indexName,
    })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        inArray(recommendations.type, [...types]),
        inArray(recommendations.state, [...LIVE_STATES]),
        // NOT (state = PROPOSED AND source = ownSource) — both columns are
        // NOT NULL, so the de Morgan form needs no null handling.
        or(ne(recommendations.state, "PROPOSED"), ne(recommendations.source, ownSource)),
      ),
    );
  return new Set(rows.map((row) => watchKey(row.database, row.collection, row.indexName)));
}
