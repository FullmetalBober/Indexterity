import {
  assessHealth,
  DEFAULT_HEALTH,
  DEFAULT_PRESSURE,
  type HealthOptions,
  MSSQL_HEALTH,
  readPressure,
} from "../analysis";
import { type Database, desc, eq, latencySamples } from "../db";
import type { ClusterEngine } from "../engine/ports";
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

// The newest stored sample per namespace, which is what "how fast was this
// collection before" means. Exported because it is the one part of the probe that
// can be wrong quietly: pick an older row and the comparison below is against the
// wrong baseline, and nothing about the finding would look unusual.
export function latestBaselines(db: Database, clusterId: string) {
  return db
    .selectDistinctOn([latencySamples.database, latencySamples.collection], {
      database: latencySamples.database,
      collection: latencySamples.collection,
      readOps: latencySamples.readOps,
      readLatencyMicros: latencySamples.readLatencyMicros,
    })
    .from(latencySamples)
    .where(eq(latencySamples.clusterId, clusterId))
    .orderBy(latencySamples.database, latencySamples.collection, desc(latencySamples.capturedAt));
}

// Returns the collections found under read pressure. The caller decides what to
// do about it; this only measures.
export async function probeCluster(db: Database, clusterId: string): Promise<PressureFinding[]> {
  // The most recent stored sample per collection is the baseline, and `distinct
  // on` is the whole point here: this used to select EVERY latency_samples row for
  // the cluster and pick the newest per namespace in JS. That is one row per
  // collection per collect since the cluster was connected — on a year-old cluster
  // with two hundred collections, ~292k rows read, shipped and mapped every five
  // minutes to arrive at two hundred. Postgres picks one per namespace instead,
  // and only the four columns the comparison below reads.
  //
  // `latency_samples_cluster_ns_time` is the index that makes it an ordered index
  // scan instead of a sort: measured on 30k synthetic rows, 9.3ms against 54.8ms,
  // and no Sort node. The planner only prefers it once a cluster is a fraction of
  // the table, which is every deployment with more than one — with a single
  // cluster filling the table a seq scan plus an in-memory quicksort is genuinely
  // cheaper, and it is welcome to choose that. What this rewrite fixes either way
  // is the part that was never the planner's call: reading every row out of
  // postgres and building a 292k-entry Map in JS to keep two hundred of them.
  //
  // Still O(rows the cluster has written); what collapses that is storing one row
  // per counter state rather than one per collect (#67).
  const baselines = await latestBaselines(db, clusterId);

  if (baselines.length === 0) return [];

  // Busiest first — a collection nobody reads cannot be suffering from a missing
  // index right now. Sorted here rather than in SQL because `distinct on` fixes
  // the leading ORDER BY, and by this point it is two hundred rows, not 292k.
  const busiest = [...baselines].sort((a, b) => b.readOps - a.readOps).slice(0, PROBE_COLLECTIONS);

  const { session, engine, release } = await openClusterSession(db, clusterId);
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
    for (const baseline of busiest) {
      const current = await session.collector
        .collectionLatency(baseline.database, baseline.collection)
        .catch(() => null);
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
