import {
  assessHealth,
  DEFAULT_HEALTH,
  DEFAULT_PRESSURE,
  type HealthOptions,
  MSSQL_HEALTH,
  readPressure,
} from "../analysis";
import { asc, type Database, desc, eq, latencySamples } from "../db";
import type { ClusterEngine, CollectionLatency } from "../engine/ports";
import type { TunnelRegistry } from "../tunnel/tunnel.registry";
import { openClusterSession } from "./cluster-connection";

// The five-minute check: is a collection suddenly much slower to read than it
// has been? That is what a missing index looks like from outside, and unlike
// CPU it is something the least-privilege user can actually see.
//
// Deliberately NOT written into latency_samples. That table's cadence is the 6h
// collect, and two things count intervals in it — the activity gate and the
// change-window inference. Dropping 5-minute rows in would silently redefine
// "an interval" for both. The probe reads, decides, and forgets.
//
// Only the busiest collections are probed: one $collStats each, and a cluster
// with hundreds of collections should not pay for all of them every five
// minutes to answer a question about the ones carrying traffic.
const PROBE_COLLECTIONS = 20;
// Gap between the two health readings. Long enough for the counters to move
// under real traffic, short enough that the probe stays a quick job.
//
// It also has a FLOOR now, which mongod did not impose: SQL Server serves
// Index Searches, Page lookups and Range Scans from a snapshot that refreshes
// on its own schedule, so two reads inside the same tick return identical
// values while Full Scans moves eagerly (measured on 2022 CU26 — a scanning
// workload read 30 full scans and a flat zero for the other three). At a
// second or more apart every counter moves exactly. Five is well clear;
// shortening this would produce silent zeros on MSSQL rather than an error.
const HEALTH_SAMPLE_MS = 5000;

// Which reading of the counters applies. The ServerHealth SHAPE is shared —
// scans, work per key, sorts, queue — and what a number in it means is not:
// SQL Server's docs-per-key analogue is pages per index search, and its sort
// counter is tempdb spills rather than in-memory sorts (analysis/health.ts has
// the derivation). Exported so the mapping is a value a test can assert on
// rather than a branch buried in the probe.
export function healthOptionsFor(engine: ClusterEngine): HealthOptions {
  return engine === "MSSQL" ? MSSQL_HEALTH : DEFAULT_HEALTH;
}

export interface PressureFinding {
  // Null for a server-wide finding, which names no single collection.
  readonly database: string | null;
  readonly collection: string | null;
  readonly reason: string;
}

// The newest stored sample for each of the `limit` busiest namespaces, which is
// what "how fast were the collections that carry traffic before" means. Exported
// because it is the one part of the probe that can be wrong quietly: pick an older
// row and the comparison below is against the wrong baseline, and nothing about
// the finding would look unusual.
//
// The limit is a PARAMETER OF THE READ, not a slice after it (#486). It used to be
// the latter, and that made the query return one row per collection on the cluster
// to keep twenty of them — twelve times an hour, per cluster, scaling with
// collection count rather than with anything the probe cares about. A cluster with
// two hundred collections shipped two hundred rows to use twenty.
//
// TWO SELECTS, because `distinct on` fixes the leading ORDER BY to the distinct
// expressions — which is exactly the constraint that put the sort in JS in the
// first place. Busiest-first cannot share that ORDER BY, so it goes on a wrapping
// select over the inner one.
//
// The tie-break is not decoration. Sorting on `read_ops` alone left ties in
// whatever order the rows arrived, which was invisible while the sort was in JS
// over the whole set and would not be here: a cluster whose collections are all
// equally idle would probe a different arbitrary twenty every five minutes, so
// nothing would ever accumulate a comparison. Namespace order is arbitrary too,
// and it is the same arbitrary order every pass.
export function latestBaselines(db: Database, clusterId: string, limit: number) {
  const newest = db
    .selectDistinctOn([latencySamples.database, latencySamples.collection], {
      database: latencySamples.database,
      collection: latencySamples.collection,
      readOps: latencySamples.readOps,
      readLatencyMicros: latencySamples.readLatencyMicros,
    })
    .from(latencySamples)
    .where(eq(latencySamples.clusterId, clusterId))
    .orderBy(latencySamples.database, latencySamples.collection, desc(latencySamples.capturedAt))
    .as("newest");
  return db
    .select({
      database: newest.database,
      collection: newest.collection,
      readOps: newest.readOps,
      readLatencyMicros: newest.readLatencyMicros,
    })
    .from(newest)
    .orderBy(desc(newest.readOps), asc(newest.database), asc(newest.collection))
    .limit(limit);
}

// Returns the collections found under read pressure. The caller decides what to
// do about it; this only measures.
export async function probeCluster(
  db: Database,
  clusterId: string,
  // The live tunnels, when this cluster is reached over one (#353).
  // Optional because most callers have none and every cluster before
  // #353 needs none; a cluster WITH a tunnel_id and no registry is
  // refused rather than dialled directly.
  tunnels?: TunnelRegistry,
): Promise<PressureFinding[]> {
  // The baseline is the most recent stored sample per collection, for the busiest
  // collections only — a collection nobody reads cannot be suffering from a
  // missing index right now.
  //
  // Both halves of that are postgres' job now (#486). The `distinct on` has been
  // for a while: this used to select EVERY latency_samples row for the cluster and
  // pick the newest per namespace in JS, one row per collection per collect since
  // the cluster was connected — on a year-old cluster with two hundred
  // collections, ~292k rows read, shipped and mapped every five minutes to arrive
  // at two hundred. The busiest-twenty was still a JS slice after it, which left
  // the read returning ten times what it used it: two hundred rows in, twenty out.
  //
  // `latency_samples_cluster_ns_time` is the index that makes the inner select an
  // ordered index scan instead of a sort: measured on 30k synthetic rows, 9.3ms
  // against 54.8ms, and no Sort node. The limit does not disturb that, which was
  // the thing to check rather than assume — it is the INNER select's ORDER BY the
  // index serves, and the wrapping sort is over one row per namespace, the set
  // that used to be sorted in JS.
  //
  // Re-measured on postgres 17, 160k rows over four clusters, 120k of them on the
  // cluster under test across 2,000 namespaces. The plan gains exactly one node:
  //
  //   Limit
  //     Sort (top-N heapsort, 27 kB)
  //       Subquery Scan
  //         Unique
  //           Index Scan using latency_samples_cluster_ns_time
  //
  // Five runs each, medians: 58.0ms unlimited against 56.9ms limited. The top-N
  // heapsort over 2,000 rows is noise beside the 120k-row index scan both plans
  // pay, so this is not a server-side speedup and is not claimed as one — the
  // saving is that 20 rows cross the wire instead of 2,000, which is the cost the
  // hosted deployment ran out of.
  //
  // The planner only prefers that index once a cluster is a fraction of the
  // table, which is every deployment with more than one — with a single cluster
  // filling the table a seq scan plus an in-memory quicksort is genuinely
  // cheaper, and it is welcome to choose that.
  //
  // Still O(rows the cluster has written) to SCAN; what collapses that is storing
  // one row per counter state rather than one per collect (#67). What the limit
  // fixes is the part that was never the planner's call: how much of the answer
  // crosses the wire.
  const busiest = await latestBaselines(db, clusterId, PROBE_COLLECTIONS);

  if (busiest.length === 0) return [];

  const { session, engine, release } = await openClusterSession(db, clusterId, { tunnels });
  try {
    const findings: PressureFinding[] = [];

    // Server-wide first. Two readings a few seconds apart show what the query
    // engine is doing right now — collection scans, documents walked per index
    // key, readers queued behind the global lock — which catches a scan storm
    // spread thinly across many collections that no single latency average
    // would flag. Null when the credentials cannot read the counters, which is
    // an optional privilege on both engines — `serverStatus` on mongod, and
    // VIEW SERVER STATE for the two DMVs on SQL Server.
    const first = await session.collector.collectServerHealth();
    if (first !== null) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_SAMPLE_MS));
      const second = await session.collector.collectServerHealth();
      if (second !== null) {
        const verdict = assessHealth(first, second, healthOptionsFor(engine));
        if (verdict.severity !== "HEALTHY" && verdict.indexRelated) {
          findings.push({ database: null, collection: null, reason: verdict.summary });
        }
      }
    }
    // One read per database where the engine offers it (#454) — on SQL Server
    // the per-collection read is a whole-Query-Store scan, and twenty of them
    // every five minutes was a third of the load the collect itself put on the
    // server. A database whose read fails is skipped whole, as a collection
    // whose read failed was.
    const collector = session.collector;
    const perDatabase = new Map<string, ReadonlyMap<string, CollectionLatency> | null>();
    if (collector.latencyByCollection !== undefined) {
      for (const database of new Set(busiest.map((baseline) => baseline.database))) {
        perDatabase.set(database, await collector.latencyByCollection(database).catch(() => null));
      }
    }
    for (const baseline of busiest) {
      const read = perDatabase.get(baseline.database);
      const current =
        read === undefined
          ? await collector
              .collectionLatency(baseline.database, baseline.collection)
              .catch(() => null)
          : (read?.get(baseline.collection) ?? null);
      if (current === null) continue;
      const verdict = readPressure(
        { ops: baseline.readOps, latencyMicros: baseline.readLatencyMicros },
        { ops: current.reads.ops, latencyMicros: current.reads.latencyMicros },
        DEFAULT_PRESSURE,
      );
      if (verdict.underPressure && verdict.reason !== null) {
        findings.push({
          database: baseline.database,
          collection: baseline.collection,
          reason: verdict.reason,
        });
      }
    }
    return findings;
  } finally {
    release();
  }
}
