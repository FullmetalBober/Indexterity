import { Injectable } from "@nestjs/common";
import type {
  AuditAction,
  ClusterCollections,
  ClusterCooldowns,
  ClusterIndexSizeSeries,
  ClusterLatency,
  ClusterLatencySeries,
  ClusterNodes,
  ClusterRoi,
  RoiContribution,
} from "@repo/contracts";
import {
  clusterNode,
  LATENCY_SERIES_MAX_COLLECTIONS,
  LATENCY_SERIES_WINDOW_DAYS,
} from "@repo/contracts";
import { z } from "zod";
import {
  chartableCollections,
  latencyGaps,
  latencyPoints,
  monthlySavingsUsd,
  summarizeFootprint,
  summarizeLatency,
} from "../analysis";
import { workerEnv } from "../config/env";
import { TenancyService } from "../http/tenancy.service";
import { isWholeCollection } from "../jobs/cooldowns";
import { InsightsRepository } from "./insights.repository";

const RECENT_ACTIONS = 50;
const TOP_CONTRIBUTORS = 10;

// Read-only views over what the engine has already decided and recorded: ROI,
// latency trends, per-collection footprint, the roster and the audit trail.
//
// Every one of them answers for a cluster the caller does not own with an EMPTY
// view rather than a refusal, and that rule lives here rather than in the
// controller: what "no such cluster, as far as you are concerned" looks like is
// the shape of the answer, and each view's empty shape is different.
@Injectable()
export class InsightsService {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly repo: InsightsRepository,
  ) {}

  async roi(clusterId: string, orgId: string): Promise<ClusterRoi> {
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) {
      return {
        clusterId,
        freedBytes: 0,
        indexesDropped: 0,
        estimatedMonthlyUsd: 0,
        attribution: [],
      };
    }
    const rows = await this.repo.roiRows(clusterId);
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
      .slice(0, TOP_CONTRIBUTORS);
    const recRows = await this.repo.recommendationsByIds(contributors.map(([id]) => id));
    const byId = new Map(recRows.map((rec) => [rec.id, rec]));
    const attribution: RoiContribution[] = contributors.flatMap(([id, bytes]) => {
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
    return {
      clusterId,
      freedBytes,
      indexesDropped,
      estimatedMonthlyUsd: monthlySavingsUsd(freedBytes, rate),
      attribution,
    };
  }

  async latency(clusterId: string, orgId: string): Promise<ClusterLatency> {
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) return { clusterId, collections: [] };
    const groups = await this.repo.latencyReadings(
      clusterId,
      await this.repo.readableSince(clusterId),
    );
    const collections = [...groups.values()].map((group) => ({
      database: group.database,
      collection: group.collection,
      ...summarizeLatency(group.readings),
    }));
    return { clusterId, collections };
  }

  // Bounded on both axes (#64), because this was the read that grew with *every
  // collect, forever*: measured at 200 collections × 90 days of hourly readings,
  // the full payload was 30.9 MB per dashboard load — of which the chart drew
  // four collections. A 30-day window bounds time (the trend chart is about
  // recently, the before/after table covers the long term), `chartableCollections`
  // bounds collections, and totalCollections keeps the cut honest on screen.
  //
  // That cut is ranked PER METRIC and not once for both charts. Ranking it once
  // is what sent the write chart eight collections nobody writes to and let it
  // report the ranking's blind spot as an absence of writes — see the comment on
  // chartableCollections, which owns the rule and the measurement behind it.
  async latencySeries(clusterId: string, orgId: string): Promise<ClusterLatencySeries> {
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) {
      return { clusterId, totalCollections: 0, collections: [] };
    }
    const since = await this.repo.readableSince(clusterId, InsightsService.trendWindow());
    const groups = await this.repo.latencyReadings(clusterId, since);
    const collections = [...groups.values()].map((group) => {
      const gaps = latencyGaps(group.readings);
      return {
        database: group.database,
        collection: group.collection,
        points: latencyPoints(group.readings),
        readGap: gaps.read,
        writeGap: gaps.write,
      };
    });
    return {
      clusterId,
      totalCollections: collections.length,
      collections: chartableCollections(collections, LATENCY_SERIES_MAX_COLLECTIONS),
    };
  }

  // Total index bytes per day (#160) — the question the ROI panel cannot answer.
  //
  // Both of ROI's numbers are cumulative and only ever go up, because they count
  // what the engine removed. Neither says whether the cluster's footprint is
  // smaller than it was, which is what an owner actually asks after a month: a
  // cluster where we freed 4 GB while the application added 6 GB has a
  // triumphant ROI panel and a larger bill.
  async indexSizeSeries(clusterId: string, orgId: string): Promise<ClusterIndexSizeSeries> {
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) {
      return { clusterId, firstBytes: null, latestBytes: null, changeBytes: null, points: [] };
    }
    const since = await this.repo.readableSince(clusterId, InsightsService.trendWindow());
    const points = await this.repo.indexSizeByDay(clusterId, since);
    return { clusterId, ...summarizeFootprint(points), points };
  }

  // Per-collection index footprint as of the latest collect.
  //
  // Deliberately NOT capped (#64's definition of done asks this be recorded):
  // one row per collection, and the 500-collection worst case measured 55 KB and
  // 28 ms — a cluster would need ~5,000 collections to reach half a megabyte,
  // and a reader with that cluster has bigger conversations to have with this
  // product than payload size.
  async collections(clusterId: string, orgId: string): Promise<ClusterCollections> {
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) return { clusterId, collections: [] };
    const snapshotRows = await this.repo.latestIndexFootprint(clusterId);
    const proposedRows = await this.repo.proposedNamespaces(clusterId);
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
      .map(([key, group]) => ({ ...group, proposedRecommendations: proposedByNs.get(key) ?? 0 }))
      .sort((a, b) => b.totalIndexBytes - a.totalIndexBytes);
    return { clusterId, collections };
  }

  // What the engine has agreed not to touch, and until when (#159).
  //
  // `active` is computed here rather than left to the browser, because a clock
  // an hour behind would draw a parked index as eligible.
  async cooldowns(clusterId: string, orgId: string): Promise<ClusterCooldowns> {
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) {
      return { clusterId, activeCount: 0, nextEligibleAt: null, parked: [] };
    }
    const rows = await this.repo.cooldowns(clusterId);
    // One `now` for the whole answer. Read per row, a cooldown expiring mid-loop
    // could be counted active and then reported with a past date.
    const now = Date.now();
    const parked = rows.map((row) => ({
      database: row.database,
      collection: row.collection,
      indexName: row.indexName,
      reason: row.reason,
      regressionCount: row.regressionCount,
      until: row.until.toISOString(),
      active: row.until.getTime() > now,
      // Computed here for the same reason `active` is: the empty index name is a
      // storage sentinel (jobs/cooldowns.ts), and the dashboard should not have
      // to know that to draw the row.
      wholeCollection: isWholeCollection(row.indexName),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
    const active = parked.filter((entry) => entry.active);
    return {
      clusterId,
      activeCount: active.length,
      // The SOONEST one still in force, which is the opposite end of the `until
      // desc` order the list is drawn in — "next eligible" is the first thing
      // that comes back, not the last.
      nextEligibleAt: active[active.length - 1]?.until ?? null,
      parked,
    };
  }

  async nodes(clusterId: string, orgId: string): Promise<ClusterNodes> {
    const empty = { clusterId, collectedAt: null, nodes: [] };
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) return empty;
    const roster = await this.repo.roster(clusterId);
    if (roster === undefined) return empty;
    // The stored strings are ClusterNode's vocabulary (engine/ports.ts), but
    // jsonb proves nothing — parse rather than assert, and let an alien value
    // fail loudly instead of drawing a badge for it.
    return {
      clusterId,
      collectedAt: roster.collectedAt.toISOString(),
      nodes: z.array(clusterNode).parse(roster.nodes),
    };
  }

  async actions(clusterId: string, orgId: string): Promise<AuditAction[]> {
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) return [];
    const rows = await this.repo.recentActions(clusterId, RECENT_ACTIONS);
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  // The chart's own window, which readableSince then clamps to the plan's.
  private static trendWindow(): Date {
    return new Date(Date.now() - LATENCY_SERIES_WINDOW_DAYS * 86_400_000);
  }
}
