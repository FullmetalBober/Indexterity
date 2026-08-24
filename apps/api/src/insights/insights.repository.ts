import { Injectable } from "@nestjs/common";
import type { LatencyReading } from "../analysis";
import { runFrom } from "../analysis/types";
import {
  actions,
  and,
  clusterIndexes,
  clusterRosters,
  desc,
  eq,
  gte,
  inArray,
  indexCooldowns,
  indexSnapshots,
  latencySamples,
  recommendations,
  roiMetrics,
  sql,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { historyWindow } from "../jobs/plan";

// One collection's latency counters over the window, grouped by namespace.
export interface LatencyGroup {
  readonly database: string;
  readonly collection: string;
  readonly readings: LatencyReading[];
}

export interface IndexSizeDay {
  readonly day: string;
  readonly totalBytes: number | null;
  readonly indexCount: number;
}

// The reads behind the insight views.
//
// This feature earns a repository where `policy` and `org` did not, and the
// deciding one is `readableSince`: the rule that a caller's window is clamped to
// the PLAN's window was written out twice, in the latency load and in the
// footprint series, and a third view would have written it a third time. It is
// the entitlement, so it is not a rule to keep re-deriving beside a chart.
//
// The two heavyweight queries are here for the same reason — the day-bucketing
// CTE and the max(last_seen_at) footprint join are each a paragraph of SQL whose
// correctness argument is about storage, not about what the chart means.
@Injectable()
export class InsightsRepository {
  constructor(private readonly database: DatabaseService) {}

  // How far back this cluster may be read.
  //
  // The plan's window is the entitlement, and rows outlive it — deletion runs
  // one cutoff for the whole deployment — so this is what actually enforces it.
  // `notBefore` tightens for a caller that only draws a recent slice (#64); it
  // can never loosen.
  async readableSince(clusterId: string, notBefore?: Date): Promise<Date> {
    const planSince = await historyWindow(this.database.db, clusterId);
    return notBefore !== undefined && notBefore > planSince ? notBefore : planSince;
  }

  async latencyReadings(clusterId: string, since: Date): Promise<Map<string, LatencyGroup>> {
    const rows = await this.database.db
      .select()
      .from(latencySamples)
      .where(and(eq(latencySamples.clusterId, clusterId), gte(latencySamples.lastSeenAt, since)));
    const groups = new Map<
      string,
      { database: string; collection: string; readings: LatencyReading[] }
    >();
    for (const row of rows) {
      const key = `${row.database} ${row.collection}`;
      const group = groups.get(key) ?? {
        database: row.database,
        collection: row.collection,
        readings: [],
      };
      // A row stands for every collect that read these same four counters, so
      // the trend and the chart get the interval and the count rather than
      // inferring a single look from a single row.
      group.readings.push({
        ...runFrom(row),
        readOps: row.readOps,
        readLatencyMicros: row.readLatencyMicros,
        writeOps: row.writeOps,
        writeLatencyMicros: row.writeLatencyMicros,
      });
      groups.set(key, group);
    }
    return groups;
  }

  async roiRows(clusterId: string) {
    return this.database.db.select().from(roiMetrics).where(eq(roiMetrics.clusterId, clusterId));
  }

  async recommendationsByIds(ids: readonly string[]) {
    if (ids.length === 0) return [];
    return this.database.db
      .select()
      .from(recommendations)
      .where(inArray(recommendations.id, [...ids]));
  }

  // Total index bytes per day, bucketed in SQL rather than shipped one point per
  // snapshot run. Runs are run-length encoded (#67), so the row count is a
  // function of how much the cluster CHANGES — a busy 200-index cluster writes
  // roughly four runs per index per day, which is 24,000 rows for a 30-day
  // window and a chart that draws 31 points.
  //
  // A day counts an index once, at the newest run that overlapped it, and a day
  // no run overlapped comes back null rather than zero — the difference between
  // "this cluster had no indexes" and "nobody looked". Overlap is the right test
  // and an instant is not: a busy index's runs end and restart around each
  // collect, so "the run covering midnight" would drop exactly the indexes whose
  // counters move.
  async indexSizeByDay(clusterId: string, since: Date): Promise<IndexSizeDay[]> {
    const rows = await this.database.db.execute<{
      day: Date;
      total_bytes: string | null;
      index_count: number;
    }>(sql`
      with days as (
        select generate_series(
          date_trunc('day', ${since}::timestamptz),
          date_trunc('day', now()),
          interval '1 day'
        ) as day
      ),
      -- One row per (day, index): the newest run that overlapped that day.
      -- distinct on rather than a window function because the ordering IS
      -- the choice, and because at most one run per index can be picked --
      -- the exclusion constraint on the span column guarantees a cluster's
      -- runs for one index never overlap each other.
      picked as (
        select distinct on (d.day, s.index_id) d.day as day, s.size_bytes
        from days d
        join ${indexSnapshots} s
          on s.cluster_id = ${clusterId}
         and s.last_seen_at >= ${since}
         and s.captured_at < d.day + interval '1 day'
         and s.last_seen_at >= d.day
        order by d.day, s.index_id, s.captured_at desc
      )
      select
        d.day,
        -- sum over no rows is null, which is the gap marker, so this is
        -- deliberately NOT coalesced to zero.
        sum(p.size_bytes)::bigint as total_bytes,
        count(p.size_bytes)::int as index_count
      from days d
      left join picked p on p.day = d.day
      group by d.day
      order by d.day
    `);
    // bigint arrives as a string from node-postgres — Number is exact to 9
    // petabytes, which is well past any index footprint.
    return rows.rows.map((row) => ({
      day: new Date(row.day).toISOString(),
      totalBytes: row.total_bytes === null ? null : Number(row.total_bytes),
      indexCount: Number(row.index_count),
    }));
  }

  // Every index the last collect saw, with its namespace.
  //
  // By `last_seen_at`, not `captured_at`, and the difference is the whole of
  // what run-length storage changes here. This used to select the newest BATCH
  // of inserts, which worked because a collect wrote a row per index and they
  // shared a timestamp. An idle index no longer gets a row per collect — it gets
  // its existing run extended — so its `captured_at` can be weeks old while the
  // index is very much still there, and the old comparison would have dropped it
  // from the footprint.
  //
  // The max(last_seen_at) comparison must stay in SQL: pg keeps microseconds and
  // a JS Date round-trip truncates to ms, so re-querying by an equal Date would
  // match nothing.
  async latestIndexFootprint(clusterId: string) {
    return this.database.db
      .select({
        database: clusterIndexes.database,
        collection: clusterIndexes.collection,
        sizeBytes: indexSnapshots.sizeBytes,
      })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(
        and(
          eq(indexSnapshots.clusterId, clusterId),
          sql`${indexSnapshots.lastSeenAt} = (select max(${indexSnapshots.lastSeenAt}) from ${indexSnapshots} where ${indexSnapshots.clusterId} = ${clusterId})`,
        ),
      );
  }

  async proposedNamespaces(clusterId: string) {
    return this.database.db
      .select({ database: recommendations.database, collection: recommendations.collection })
      .from(recommendations)
      .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "PROPOSED")));
  }

  // Every row, not only the ones still in force, and never joined to
  // `recommendations`. A cooldown outlives its cause: `recordManualVeto` parks an
  // index for 90 days when an owner cancels or undoes a drop, and the
  // recommendation that was cancelled is a row the next classify pass rewrites.
  // Joining would drop exactly the longest-standing entries.
  async cooldowns(clusterId: string) {
    return this.database.db
      .select()
      .from(indexCooldowns)
      .where(eq(indexCooldowns.clusterId, clusterId))
      .orderBy(desc(indexCooldowns.until));
  }

  async roster(clusterId: string) {
    const [row] = await this.database.db
      .select()
      .from(clusterRosters)
      .where(eq(clusterRosters.clusterId, clusterId))
      .limit(1);
    return row;
  }

  async recentActions(clusterId: string, limit: number) {
    return this.database.db
      .select({
        id: actions.id,
        kind: actions.kind,
        actor: actions.actor,
        result: actions.result,
        database: recommendations.database,
        collection: recommendations.collection,
        indexName: recommendations.indexName,
        createdAt: actions.createdAt,
      })
      .from(actions)
      .innerJoin(recommendations, eq(actions.recommendationId, recommendations.id))
      .where(eq(recommendations.clusterId, clusterId))
      .orderBy(desc(actions.createdAt))
      .limit(limit);
  }
}
