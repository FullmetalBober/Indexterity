import type { ChartEvidence } from "../analysis";
import { type Database, sql } from "../db";

// The overview's two latency reads, folded where the rows are (#614).
//
// Both used to select every reading of every collection over their window and
// reduce it here: the before/after summary over the plan's whole history and the
// chart over thirty days. Measured on the hosted deployment with
// `EXPLAIN (ANALYZE, SERIALIZE)`, a MongoDB cluster of ~100 collections shipped
// 2.8 MB for the one and 2.0 MB for the other — on every load of the page, and
// again on every collect while it stayed open, of a database whose free plan
// allows 5 GB of egress a month. What the page needs is one summary per
// collection and the points of the eight collections it charts.
//
// So the summary is the first and the last measurable window of each metric,
// picked out by `lag()` exactly as `summarizeLatency` picks them out of the rows,
// and the chart is ranked on counts (`chartableNamespaces`) before any of its
// rows are read. The rules stay in analysis/latency.ts, where they were, and the
// integration suite holds each query to the function it reproduces — the same
// arrangement as classify's evidence (jobs/latency-evidence.ts, #485).

// Every reading in the window with its neighbour's counters beside it, and the
// windowed average of each metric between the two: Δmicros over Δops, null where
// no ops went through or a total fell — `windowAvg`'s two refusals. Ordered by
// captured_at alone, which is total within a namespace: the exclusion constraint
// latency_samples_no_overlap forbids two runs for one namespace whose spans
// intersect, so no two share a start.
function steps(clusterId: string, since: Date) {
  return sql`
    with readings as (
      select
        namespace_id,
        captured_at,
        last_seen_at,
        observations,
        read_ops,
        read_latency_micros,
        write_ops,
        write_latency_micros,
        lag(read_ops) over w as prev_read_ops,
        lag(read_latency_micros) over w as prev_read_micros,
        lag(write_ops) over w as prev_write_ops,
        lag(write_latency_micros) over w as prev_write_micros
      from latency_samples
      where cluster_id = ${clusterId}::uuid
        and last_seen_at >= ${since.toISOString()}::timestamptz
      window w as (partition by namespace_id order by captured_at)
    ),
    steps as (
      select
        namespace_id,
        captured_at,
        last_seen_at,
        observations,
        case
          when read_ops - prev_read_ops > 0 and read_latency_micros - prev_read_micros >= 0
          then (read_latency_micros - prev_read_micros)::double precision
               / (read_ops - prev_read_ops)::double precision
        end as read_micros,
        case
          when write_ops - prev_write_ops > 0 and write_latency_micros - prev_write_micros >= 0
          then (write_latency_micros - prev_write_micros)::double precision
               / (write_ops - prev_write_ops)::double precision
        end as write_micros
      from readings
    )
  `;
}

export interface LatencySummary {
  readonly database: string;
  readonly collection: string;
  // Collects, not rows: a run stands for every collect that read it.
  readonly samples: number;
  readonly baselineRead: number | null;
  readonly currentRead: number | null;
  readonly baselineWrite: number | null;
  readonly currentWrite: number | null;
}

interface SummaryRow extends Record<string, unknown> {
  database: string;
  collection: string;
  samples: string;
  baseline_read: number | null;
  current_read: number | null;
  baseline_write: number | null;
  current_write: number | null;
}

// One row per collection with a reading in the window: how many collects it
// stands for, and the first and last measurable window of each metric.
export async function latencySummaries(
  db: Database,
  clusterId: string,
  since: Date,
): Promise<LatencySummary[]> {
  const result = await db.execute<SummaryRow>(sql`
    ${steps(clusterId, since)}
    select n.database, n.collection, f.samples, f.baseline_read, f.current_read,
           f.baseline_write, f.current_write
    from (
      select
        namespace_id,
        -- observationsOf's floor of one, which the column's own default already
        -- keeps it above.
        sum(greatest(observations, 1))::bigint as samples,
        (array_agg(read_micros order by captured_at) filter (where read_micros is not null))[1]
          as baseline_read,
        (array_agg(read_micros order by captured_at desc) filter (where read_micros is not null))[1]
          as current_read,
        (array_agg(write_micros order by captured_at) filter (where write_micros is not null))[1]
          as baseline_write,
        (array_agg(write_micros order by captured_at desc) filter (where write_micros is not null))[1]
          as current_write
      from steps
      group by namespace_id
    ) f
    join cluster_namespaces n on n.id = f.namespace_id
    order by n.database, n.collection
  `);
  return result.rows.map((row) => ({
    database: row.database,
    collection: row.collection,
    samples: Number(row.samples),
    baselineRead: row.baseline_read,
    currentRead: row.current_read,
    baselineWrite: row.baseline_write,
    currentWrite: row.current_write,
  }));
}

export interface ChartEvidenceRow extends ChartEvidence {
  readonly namespaceId: number;
}

interface EvidenceRow extends Record<string, unknown> {
  namespace_id: number;
  database: string;
  collection: string;
  read_points: string;
  write_points: string;
  points: string;
}

// What the chart ranking needs of every collection with a reading in the
// window, counted the way `latencyPoints` produces points: a point between each
// two readings, drawable for a metric when its window is measurable, and a gap
// at the end of every reading that stood for more than one collect. The stamps
// are compared to the millisecond, because that is all a Date carries.
export async function latencyChartEvidence(
  db: Database,
  clusterId: string,
  since: Date,
): Promise<ChartEvidenceRow[]> {
  const result = await db.execute<EvidenceRow>(sql`
    ${steps(clusterId, since)}
    select n.id as namespace_id, n.database, n.collection,
           f.read_points, f.write_points, f.points
    from (
      select
        namespace_id,
        count(*) filter (where read_micros is not null) as read_points,
        count(*) filter (where write_micros is not null) as write_points,
        count(*) - 1
          + count(*) filter (
              where date_trunc('milliseconds', last_seen_at) > date_trunc('milliseconds', captured_at)
            ) as points
      from steps
      group by namespace_id
    ) f
    join cluster_namespaces n on n.id = f.namespace_id
  `);
  return result.rows.map((row) => ({
    namespaceId: Number(row.namespace_id),
    database: row.database,
    collection: row.collection,
    readPoints: Number(row.read_points),
    writePoints: Number(row.write_points),
    points: Number(row.points),
  }));
}
