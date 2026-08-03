import { and, type Database, eq, inArray, recommendations } from "../db";

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
        inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE"]),
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
