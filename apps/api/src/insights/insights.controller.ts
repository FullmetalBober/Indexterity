import { Controller, Req } from "@nestjs/common";
import type { RoiContribution } from "@repo/contracts";
import {
  clusterNode,
  contract,
  LATENCY_SERIES_MAX_COLLECTIONS,
  LATENCY_SERIES_WINDOW_DAYS,
} from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type LatencyReading,
  latencyGaps,
  latencyPoints,
  monthlySavingsUsd,
  summarizeFootprint,
  summarizeLatency,
} from "../analysis";
import { runFrom } from "../analysis/types";
import { workerEnv } from "../config/env";
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
import { TenancyService } from "../http/tenancy.service";
import { isWholeCollection } from "../jobs/cooldowns";
import { historyWindow } from "../jobs/plan";
import { Implement, route } from "../orpc/implement";

// Read-only views over what the engine has already decided and recorded: ROI,
// latency trends, per-collection footprint, and the audit trail.
@Controller()
export class InsightsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
  ) {}

  private async loadLatencyReadings(
    clusterId: string,
    // A floor tighter than the plan's window, when the caller only draws a
    // recent slice (#64). Never looser: the plan window is the entitlement.
    notBefore?: Date,
  ): Promise<Map<string, { database: string; collection: string; readings: LatencyReading[] }>> {
    // The plan's window. Rows outlive it — deletion runs one cutoff for the whole
    // deployment now — so this is what actually enforces the entitlement.
    const planSince = await historyWindow(this.database.db, clusterId);
    const since = notBefore !== undefined && notBefore > planSince ? notBefore : planSince;
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
      // A row stands for every collect that read these same four counters, so the
      // trend and the chart get the interval and the count rather than inferring a
      // single look from a single row.
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

  @Implement(contract.getRoi)
  getRoi(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getRoi, req, "member").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
          return {
            clusterId: input.clusterId,
            freedBytes: 0,
            indexesDropped: 0,
            estimatedMonthlyUsd: 0,
            attribution: [],
          };
        }
        const rows = await this.database.db
          .select()
          .from(roiMetrics)
          .where(eq(roiMetrics.clusterId, input.clusterId));
        // Undo corrections insert negative rows; the headline never goes below zero.
        const freedBytes = Math.max(
          0,
          rows.reduce((sum, row) => sum + row.freedBytes, 0),
        );
        const indexesDropped = Math.max(
          0,
          rows.reduce((sum, row) => sum + row.indexCountDelta, 0),
        );
        const rate = workerEnv().STORAGE_USD_PER_GB_MONTH;
        // Attribution: net freed bytes per recommendation (drop rows minus undo
        // rows), positive contributors only, biggest first.
        const net = new Map<string, number>();
        for (const row of rows) {
          if (row.recommendationId === null) continue;
          net.set(row.recommendationId, (net.get(row.recommendationId) ?? 0) + row.freedBytes);
        }
        const contributors = [...net.entries()]
          .filter(([, bytes]) => bytes > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        let attribution: RoiContribution[] = [];
        if (contributors.length > 0) {
          const recRows = await this.database.db
            .select()
            .from(recommendations)
            .where(
              inArray(
                recommendations.id,
                contributors.map(([id]) => id),
              ),
            );
          const byId = new Map(recRows.map((rec) => [rec.id, rec]));
          attribution = contributors.flatMap(([id, bytes]) => {
            const rec = byId.get(id);
            if (rec === undefined) return [];
            return [
              {
                recommendationId: id,
                database: rec.database,
                collection: rec.collection,
                indexName: rec.indexName,
                freedBytes: bytes,
                estimatedMonthlyUsd: monthlySavingsUsd(bytes, rate),
              },
            ];
          });
        }
        return {
          clusterId: input.clusterId,
          freedBytes,
          indexesDropped,
          estimatedMonthlyUsd: monthlySavingsUsd(freedBytes, rate),
          attribution,
        };
      },
    );
  }

  @Implement(contract.getLatency)
  getLatency(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getLatency, req, "member").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
          return { clusterId: input.clusterId, collections: [] };
        }
        const groups = await this.loadLatencyReadings(input.clusterId);
        const collections = [...groups.values()].map((group) => ({
          database: group.database,
          collection: group.collection,
          ...summarizeLatency(group.readings),
        }));
        return { clusterId: input.clusterId, collections };
      },
    );
  }

  // Bounded on both axes (#64), because this was the read that grew with
  // *every collect, forever*: measured at 200 collections × 90 days of hourly
  // readings, the full payload was 30.9 MB per dashboard load — of which the
  // chart drew four collections. A 30-day window bounds time (the trend chart
  // is about recently, the before/after table covers the long term), the
  // top-N by evidence bounds collections the same way the chart already
  // ranked them, and totalCollections keeps the cut honest on screen.
  @Implement(contract.getLatencySeries)
  getLatencySeries(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getLatencySeries, req, "member").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
          return { clusterId: input.clusterId, totalCollections: 0, collections: [] };
        }
        const window = new Date(Date.now() - LATENCY_SERIES_WINDOW_DAYS * 86_400_000);
        const groups = await this.loadLatencyReadings(input.clusterId, window);
        const collections = [...groups.values()]
          .map((group) => {
            const gaps = latencyGaps(group.readings);
            return {
              database: group.database,
              collection: group.collection,
              points: latencyPoints(group.readings),
              readGap: gaps.read,
              writeGap: gaps.write,
            };
          })
          .sort((a, b) => b.points.length - a.points.length);
        return {
          clusterId: input.clusterId,
          totalCollections: collections.length,
          collections: collections.slice(0, LATENCY_SERIES_MAX_COLLECTIONS),
        };
      },
    );
  }

  // Total index bytes per day (#160) — the question the ROI panel cannot answer.
  //
  // Both of ROI's numbers are cumulative and only ever go up, because they count
  // what the engine removed. Neither says whether the cluster's footprint is
  // smaller than it was, which is what an owner actually asks after a month: a
  // cluster where we freed 4 GB while the application added 6 GB has a
  // triumphant ROI panel and a larger bill.
  //
  // Bucketed in SQL, one point per day, rather than shipped one point per
  // snapshot run. Runs are run-length encoded (#67), so the row count is a
  // function of how much the cluster CHANGES — a busy 200-index cluster writes
  // roughly four runs per index per day, which is 24,000 rows for a 30-day
  // window and a chart that draws 31 points.
  //
  // A day counts an index once, at the newest run that overlapped it, and a day
  // no run overlaps comes back null rather than zero — the difference between
  // "this cluster had no indexes" and "nobody looked". Overlap is the right test
  // and an instant is not: a busy index's runs end and restart around each
  // collect, so "the run covering midnight" would drop exactly the indexes whose
  // counters move.
  @Implement(contract.getIndexSizeSeries)
  getIndexSizeSeries(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getIndexSizeSeries, req, "member").handler(
      async ({ input, context }) => {
        const empty = {
          clusterId: input.clusterId,
          firstBytes: null,
          latestBytes: null,
          changeBytes: null,
          points: [],
        };
        if (!(await this.tenancy.ownsCluster(input.clusterId, context.member.orgId))) return empty;
        // The plan's window is the entitlement and the trend window is the
        // chart's; whichever is tighter wins, exactly as loadLatencyReadings
        // does it.
        const planSince = await historyWindow(this.database.db, input.clusterId);
        const trendSince = new Date(Date.now() - LATENCY_SERIES_WINDOW_DAYS * 86_400_000);
        const since = trendSince > planSince ? trendSince : planSince;
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
              on s.cluster_id = ${input.clusterId}
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
        const points = rows.rows.map((row) => ({
          day: new Date(row.day).toISOString(),
          totalBytes: row.total_bytes === null ? null : Number(row.total_bytes),
          indexCount: Number(row.index_count),
        }));
        return { clusterId: input.clusterId, ...summarizeFootprint(points), points };
      },
    );
  }

  // Per-collection index footprint as of the latest collect.
  //
  // Deliberately NOT capped (#64's definition of done asks this be recorded):
  // one row per collection, and the 500-collection worst case measured 55 KB
  // and 28 ms — a cluster would need ~5,000 collections to reach half a
  // megabyte, and a reader with that cluster has bigger conversations to have
  // with this product than payload size.
  //
  // By `last_seen_at`, not `captured_at`, and the difference is the whole of what
  // run-length storage changes here. This used to select the newest BATCH of
  // inserts, which worked because a collect wrote a row per index and they shared
  // a timestamp. An idle index no longer gets a row per collect — it gets its
  // existing run extended — so its `captured_at` can be weeks old while the index
  // is very much still there, and the old comparison would have dropped it from
  // the footprint. Every index the last collect saw was either extended or
  // inserted at that moment, so they all share `last_seen_at` instead.
  @Implement(contract.getCollections)
  getCollections(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getCollections, req, "member").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
          return { clusterId: input.clusterId, collections: [] };
        }
        // The max(last_seen_at) comparison must stay in SQL: pg keeps microseconds
        // and a JS Date round-trip truncates to ms, so re-querying by an equal
        // Date would match nothing.
        const snapshotRows = await this.database.db
          .select({
            database: clusterIndexes.database,
            collection: clusterIndexes.collection,
            sizeBytes: indexSnapshots.sizeBytes,
          })
          .from(indexSnapshots)
          .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
          .where(
            and(
              eq(indexSnapshots.clusterId, input.clusterId),
              sql`${indexSnapshots.lastSeenAt} = (select max(${indexSnapshots.lastSeenAt}) from ${indexSnapshots} where ${indexSnapshots.clusterId} = ${input.clusterId})`,
            ),
          );
        const proposedRows = await this.database.db
          .select({ database: recommendations.database, collection: recommendations.collection })
          .from(recommendations)
          .where(
            and(
              eq(recommendations.clusterId, input.clusterId),
              eq(recommendations.state, "PROPOSED"),
            ),
          );
        const proposedByNs = new Map<string, number>();
        for (const rec of proposedRows) {
          const key = `${rec.database} ${rec.collection}`;
          proposedByNs.set(key, (proposedByNs.get(key) ?? 0) + 1);
        }
        const byNs = new Map<
          string,
          { database: string; collection: string; indexCount: number; totalIndexBytes: number }
        >();
        for (const row of snapshotRows) {
          const key = `${row.database} ${row.collection}`;
          const group = byNs.get(key) ?? {
            database: row.database,
            collection: row.collection,
            indexCount: 0,
            totalIndexBytes: 0,
          };
          group.indexCount += 1;
          group.totalIndexBytes += row.sizeBytes;
          byNs.set(key, group);
        }
        const collections = [...byNs.entries()]
          .map(([key, group]) => ({
            ...group,
            proposedRecommendations: proposedByNs.get(key) ?? 0,
          }))
          .sort((a, b) => b.totalIndexBytes - a.totalIndexBytes);
        return { clusterId: input.clusterId, collections };
      },
    );
  }

  // What the engine has agreed not to touch, and until when (#159).
  //
  // Read from `index_cooldowns` alone, never joined to `recommendations`. A
  // cooldown outlives its cause: `recordManualVeto` parks an index for 90 days
  // when an owner cancels or undoes a drop, and the recommendation that was
  // cancelled is a row the next classify pass rewrites. Joining would drop
  // exactly the longest-standing entries, which are the interesting ones.
  //
  // Every row, not only the ones still in force. An expired cooldown is the only
  // record that this index has been parked before and how often it regressed,
  // and `regression_count` has no other home in the product — but `active` is
  // computed here rather than left to the browser, because a clock an hour
  // behind would draw a parked index as eligible.
  @Implement(contract.listCooldowns)
  listCooldowns(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listCooldowns, req, "member").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
          return {
            clusterId: input.clusterId,
            activeCount: 0,
            nextEligibleAt: null,
            parked: [],
          };
        }
        const rows = await this.database.db
          .select()
          .from(indexCooldowns)
          .where(eq(indexCooldowns.clusterId, input.clusterId))
          .orderBy(desc(indexCooldowns.until));
        // One `now` for the whole answer. Read per row, a cooldown expiring
        // mid-loop could be counted active and then reported with a past date.
        const now = Date.now();
        const parked = rows.map((row) => ({
          database: row.database,
          collection: row.collection,
          indexName: row.indexName,
          reason: row.reason,
          regressionCount: row.regressionCount,
          until: row.until.toISOString(),
          active: row.until.getTime() > now,
          // Computed here for the same reason `active` is: the empty index name
          // is a storage sentinel (jobs/cooldowns.ts), and the dashboard should
          // not have to know that to draw the row.
          wholeCollection: isWholeCollection(row.indexName),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));
        const active = parked.filter((entry) => entry.active);
        return {
          clusterId: input.clusterId,
          activeCount: active.length,
          // The SOONEST one still in force, which is the opposite end of the
          // `until desc` order the list is drawn in — "next eligible" is the
          // first thing that comes back, not the last.
          nextEligibleAt: active[active.length - 1]?.until ?? null,
          parked,
        };
      },
    );
  }

  @Implement(contract.getNodes)
  getNodes(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getNodes, req, "member").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
          return { clusterId: input.clusterId, collectedAt: null, nodes: [] };
        }
        const [roster] = await this.database.db
          .select()
          .from(clusterRosters)
          .where(eq(clusterRosters.clusterId, input.clusterId))
          .limit(1);
        if (roster === undefined) {
          return { clusterId: input.clusterId, collectedAt: null, nodes: [] };
        }
        // The stored strings are ClusterNode's vocabulary (engine/ports.ts), but
        // jsonb proves nothing — parse rather than assert, and let an alien
        // value fail loudly instead of drawing a badge for it.
        return {
          clusterId: input.clusterId,
          collectedAt: roster.collectedAt.toISOString(),
          nodes: z.array(clusterNode).parse(roster.nodes),
        };
      },
    );
  }

  @Implement(contract.listActions)
  listActions(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listActions, req, "member").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) return [];
        const rows = await this.database.db
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
          .where(eq(recommendations.clusterId, input.clusterId))
          .orderBy(desc(actions.createdAt))
          .limit(50);
        return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
      },
    );
  }

  // Seal a connection string and insert the cluster row (read-only by default).
}
