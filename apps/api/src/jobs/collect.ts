import {
  and,
  clusterIndexes,
  type Database,
  desc,
  eq,
  inArray,
  indexSnapshots,
  latencySamples,
  sql,
} from "../db";
import { workloadKey } from "../engine/ports";
import { type CollectedLatency, type CollectedSnapshot, collectSnapshots } from "../mongo";
import { openClusterSession } from "./cluster-connection";
import { jobDb } from "./db";
import { type CurrentRun, counterFingerprint, extendsRun, latencyFingerprint } from "./runs";
import { watchKey } from "./watched";

// Collect index snapshots + per-collection read/write latency for a hosted-direct
// cluster into Postgres.
//
// Two things stop this being an insert per index per collect, and both exist
// because the old shape spent its storage recording that nothing had happened.
//
//   The DIMENSION. An index's spec and its (database, collection, name) triple
//   are constants of the index, not observations of it, and they were two thirds
//   of every row. They live in cluster_indexes now, written once.
//
//   The RUN. An idle index reports a byte-identical counter every time, so the
//   row it already has gets its `lastSeenAt` moved forward instead of a new one
//   being written. Storage then tracks how much the cluster CHANGES rather than
//   how often we look at it, which is what makes looking more often affordable.
//
// What it deliberately does NOT do is skip the write. See runs.ts: a missing row
// and an idle index have to stay distinguishable, so "nothing changed" is
// recorded as a positive statement about a moment we were watching.

// The separator watchKey and workloadKey already use: the byte cannot occur in a
// mongo database, collection or index name, so no pair of real names can be made
// to collide.
const SEP = "\u0000";

// An index's identity AND the shape it was in. A rebuilt index has a dimension
// row per shape, and the one a collect belongs to is the one whose spec matches
// what was just read off the cluster.
function shapeKey(database: string, collection: string, indexName: string, spec: unknown): string {
  return `${watchKey(database, collection, indexName)}${SEP}${canonicalSpec(spec)}`;
}

// Canonical form of a spec, for comparing an incoming spec against a stored one
// WITHOUT having to agree with the digest Postgres generates. Key order differs
// across the round trip — mongo's order going out, jsonb's sorted order coming
// back — so a plain JSON.stringify would report every stored spec as changed.
function canonicalSpec(spec: unknown): string {
  if (Array.isArray(spec)) return `[${spec.map(canonicalSpec).join(",")}]`;
  if (spec === null || typeof spec !== "object") return JSON.stringify(spec) ?? "null";
  const entries = Object.entries(spec as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${canonicalSpec(value)}`).join(",")}}`;
}

// Both dimension reads want exactly these columns, and they have to agree: a key
// built from a different column set lands in the map under a different string, and
// the writer then inserts a duplicate dimension row — the one failure this table
// exists to prevent.
const DIMENSION_COLUMNS = {
  id: clusterIndexes.id,
  database: clusterIndexes.database,
  collection: clusterIndexes.collection,
  indexName: clusterIndexes.indexName,
  spec: clusterIndexes.spec,
};

interface DimensionRow {
  readonly id: string;
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
  readonly spec: Record<string, unknown>;
}

// The dimension row for every index in this collect, creating the ones we have
// not seen in this shape before. Returns index_id per (database, collection,
// name).
//
// Read first, insert only what is missing. The obvious `insert … on conflict do
// nothing … returning` is one round trip fewer and wrong for this table: a
// conflicting row still leaves a dead tuple behind, so the table built to stop
// rewriting unchanged data would be rewritten on every collect. In the steady
// state nothing is missing and this is a single select.
// It does mean reading every stored spec back on every collect, which is the one
// cost this design pays rather than removes — roughly 240 bytes per index. The
// alternative is reproducing Postgres' generated `md5(spec::text)` in JS, and the
// day that canonical form drifted the writer would start quietly inserting a
// second dimension row for an index that never changed. Re-reading a constant is
// the cheaper thing to be wrong about.
async function dimensionIds(
  db: Database,
  clusterId: string,
  snapshots: readonly CollectedSnapshot[],
): Promise<Map<string, string>> {
  // Keyed once rather than per lookup: a shape key canonicalises a spec, so
  // rebuilding it at each of the three use sites would canonicalise three times.
  const wanted = snapshots.map((snapshot) => ({
    identity: watchKey(snapshot.database, snapshot.collection, snapshot.indexName),
    shape: shapeKey(snapshot.database, snapshot.collection, snapshot.indexName, snapshot.spec),
    snapshot,
  }));

  const byShape = new Map<string, string>();
  const remember = (rows: readonly DimensionRow[]): void => {
    for (const row of rows) {
      byShape.set(shapeKey(row.database, row.collection, row.indexName, row.spec), row.id);
    }
  };

  remember(
    await db
      .select(DIMENSION_COLUMNS)
      .from(clusterIndexes)
      .where(eq(clusterIndexes.clusterId, clusterId)),
  );

  const missing = wanted.filter((entry) => !byShape.has(entry.shape));
  if (missing.length > 0) {
    await db
      .insert(clusterIndexes)
      .values(
        missing.map(({ snapshot }) => ({
          clusterId,
          database: snapshot.database,
          collection: snapshot.collection,
          indexName: snapshot.indexName,
          spec: snapshot.spec,
        })),
      )
      // Two collects for one cluster can overlap — a scheduled tick and the one
      // that fires on connect. The loser of the race finds its row already there.
      .onConflictDoNothing();
    // Re-read rather than trusting `returning`, which skips whatever the conflict
    // dropped. Narrowed to the names that were missing, so a cluster that gained
    // one index does not re-read the other sixteen hundred.
    remember(
      await db
        .select(DIMENSION_COLUMNS)
        .from(clusterIndexes)
        .where(
          and(
            eq(clusterIndexes.clusterId, clusterId),
            inArray(
              clusterIndexes.indexName,
              missing.map(({ snapshot }) => snapshot.indexName),
            ),
          ),
        ),
    );
  }

  const ids = new Map<string, string>();
  for (const entry of wanted) {
    const id = byShape.get(entry.shape);
    if (id !== undefined) ids.set(entry.identity, id);
  }
  return ids;
}

// Extend the run each index already has, or start a new one.
async function recordSnapshots(
  db: Database,
  clusterId: string,
  snapshots: readonly CollectedSnapshot[],
  now: Date,
): Promise<void> {
  if (snapshots.length === 0) return;
  const ids = await dimensionIds(db, clusterId, snapshots);
  const indexIds = [...ids.values()];
  if (indexIds.length === 0) return;

  // The newest run per index. `distinct on` over index_snapshots_index_time, so
  // this reads one row per index rather than the cluster's whole history.
  const newest = await db
    .selectDistinctOn([indexSnapshots.indexId], {
      id: indexSnapshots.id,
      indexId: indexSnapshots.indexId,
      perMember: indexSnapshots.perMember,
      lastSeenAt: indexSnapshots.lastSeenAt,
    })
    .from(indexSnapshots)
    .where(inArray(indexSnapshots.indexId, indexIds))
    .orderBy(indexSnapshots.indexId, desc(indexSnapshots.capturedAt));
  const current = new Map<string, CurrentRun & { id: string }>();
  for (const row of newest) {
    current.set(row.indexId, {
      id: row.id,
      fingerprint: counterFingerprint(row.perMember),
      lastSeenAt: row.lastSeenAt,
    });
  }

  const extend: { id: string; sizeBytes: number; hinted: boolean }[] = [];
  const insert: (typeof indexSnapshots.$inferInsert)[] = [];
  for (const snapshot of snapshots) {
    const indexId = ids.get(watchKey(snapshot.database, snapshot.collection, snapshot.indexName));
    if (indexId === undefined) continue;
    const run = current.get(indexId);
    if (run !== undefined && extendsRun(run, counterFingerprint(snapshot.perMember), now)) {
      extend.push({ id: run.id, sizeBytes: snapshot.sizeBytes, hinted: snapshot.hinted });
      continue;
    }
    insert.push({
      clusterId,
      indexId,
      sizeBytes: snapshot.sizeBytes,
      perMember: snapshot.perMember,
      hinted: snapshot.hinted,
      capturedAt: now,
      lastSeenAt: now,
      observations: 1,
    });
  }

  if (extend.length > 0) {
    // One statement for every extended run, and three parameters however many
    // that is — a values list would have needed three per row. Size and hinted
    // vary per index, so they travel as parallel arrays: size is replaced with
    // the current reading (nothing reads the size series, and every caller wants
    // the live number), while hinted is OR-ed, because one sighting of a hint
    // anywhere in the retained history is what protects the index and the next
    // quiet collect must not erase it.
    await db.execute(sql`
      update ${indexSnapshots} as s
      set last_seen_at = ${now},
          observations = s.observations + 1,
          size_bytes = v.size_bytes,
          hinted = s.hinted or v.hinted
      from unnest(
        ${sql.param(extend.map((row) => row.id))}::uuid[],
        ${sql.param(extend.map((row) => row.sizeBytes))}::bigint[],
        ${sql.param(extend.map((row) => row.hinted))}::boolean[]
      ) as v(id, size_bytes, hinted)
      where s.id = v.id
    `);
  }
  if (insert.length > 0) await db.insert(indexSnapshots).values(insert);
}

// The same two rules over latency_samples. No dimension half here: every column
// is a measurement, so the namespace stays on the row.
async function recordLatency(
  db: Database,
  clusterId: string,
  latency: readonly CollectedLatency[],
  now: Date,
): Promise<void> {
  if (latency.length === 0) return;
  const newest = await db
    .selectDistinctOn([latencySamples.database, latencySamples.collection], {
      id: latencySamples.id,
      database: latencySamples.database,
      collection: latencySamples.collection,
      readOps: latencySamples.readOps,
      readLatencyMicros: latencySamples.readLatencyMicros,
      writeOps: latencySamples.writeOps,
      writeLatencyMicros: latencySamples.writeLatencyMicros,
      lastSeenAt: latencySamples.lastSeenAt,
    })
    .from(latencySamples)
    .where(eq(latencySamples.clusterId, clusterId))
    .orderBy(latencySamples.database, latencySamples.collection, desc(latencySamples.capturedAt));
  const current = new Map<string, CurrentRun & { id: string }>();
  for (const row of newest) {
    current.set(workloadKey(row.database, row.collection), {
      id: row.id,
      fingerprint: latencyFingerprint(row),
      lastSeenAt: row.lastSeenAt,
    });
  }

  const extend: string[] = [];
  const insert: (typeof latencySamples.$inferInsert)[] = [];
  for (const sample of latency) {
    const run = current.get(workloadKey(sample.database, sample.collection));
    if (run !== undefined && extendsRun(run, latencyFingerprint(sample), now)) {
      extend.push(run.id);
      continue;
    }
    insert.push({ clusterId, ...sample, capturedAt: now, lastSeenAt: now, observations: 1 });
  }

  if (extend.length > 0) {
    await db
      .update(latencySamples)
      .set({ lastSeenAt: now, observations: sql`${latencySamples.observations} + 1` })
      .where(inArray(latencySamples.id, extend));
  }
  if (insert.length > 0) await db.insert(latencySamples).values(insert);
}

export async function collectCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const { session, release } = await openClusterSession(db, clusterId);
  try {
    const { snapshots, latency } = await collectSnapshots(session);
    // One stamp for the whole collect. Every row it touches then agrees about
    // when we looked, which is what lets a reader recover the set of indexes
    // present at the last collect as `last_seen_at = max(last_seen_at)`.
    const now = new Date();
    // Two independent tables, so they go together rather than one after the
    // other — the point of this change is to make collecting more often cheap,
    // and a serialised round trip is the kind of cost that scales with cadence.
    await Promise.all([
      recordSnapshots(db, clusterId, snapshots, now),
      recordLatency(db, clusterId, latency, now),
    ]);
    return snapshots.length;
  } finally {
    release();
  }
}
