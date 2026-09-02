import { Injectable } from "@nestjs/common";
import type {
  AuditAction,
  ClusterCollections,
  ClusterCooldowns,
  ClusterIndexes,
  ClusterIndexSizeSeries,
  ClusterLatency,
  ClusterLatencySeries,
  ClusterNodes,
  ClusterRoi,
  IndexRecommendationLink,
  RoiContribution,
} from "@repo/contracts";
import {
  CLUSTER_INDEXES_PAGE,
  clusterNode,
  instant,
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
import { parseStoredSpec } from "../analysis/recommend";
import { workerEnv } from "../config/env";
import { TenancyService } from "../http/tenancy.service";
import { isWholeCollection } from "../jobs/cooldowns";
import { InsightsRepository } from "./insights.repository";

const RECENT_ACTIONS = 50;
const TOP_CONTRIBUTORS = 10;

// What the inventory page was asked for: an optional namespace scope, and the
// cursor of the page before this one. Mirrors the contract's input rather than
// re-deriving it, and stays a plain interface for the same reason
// `SecurityTrailQuery` does — the controller has already validated it, so
// re-parsing here would be a second opinion about a settled question.
export interface ClusterIndexQuery {
  readonly database?: string | undefined;
  readonly collection?: string | undefined;
  readonly afterDatabase?: string | undefined;
  readonly afterCollection?: string | undefined;
  readonly afterIndexName?: string | undefined;
}

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

  // Every index the cluster HAS, one page of it (#431).
  //
  // The gap this closes: index-level numbers reached the dashboard only through
  // `IndexUsage`, which is keyed by `recommendationId` because D66 attached it
  // to the recommendations table. An index nobody had proposed anything about
  // therefore had no size, no counters and no spec on any screen — so the only
  // indexes a customer could see were the ones we already wanted to change, and
  // everything the engine judged fine was invisible, including the judgement.
  //
  // No collector work and no new storage: `cluster_indexes` has carried the spec
  // and `index_snapshots` the size and per-member counters since #67.
  async clusterIndexes(
    clusterId: string,
    orgId: string,
    query: ClusterIndexQuery,
  ): Promise<ClusterIndexes> {
    const empty = {
      clusterId,
      indexes: [],
      total: 0,
      nextDatabase: null,
      nextCollection: null,
      nextIndexName: null,
      collectedAt: null,
    };
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) return empty;
    // Display only — the page's own filter keeps the comparison in SQL, because
    // this value has lost its microseconds on the way here.
    const collectedAt = await this.repo.latestIndexReadingAt(clusterId);
    if (collectedAt === null) return empty;

    const { rows, total } = await this.repo.clusterIndexPage(
      clusterId,
      query,
      CLUSTER_INDEXES_PAGE,
    );
    const page = rows.slice(0, CLUSTER_INDEXES_PAGE);
    const more = rows.length > CLUSTER_INDEXES_PAGE;
    const last = page[page.length - 1];

    // One lookup per namespace ON THIS PAGE, deduplicated: a hundred indexes
    // commonly live in a handful of collections, and the point of paging is that
    // nothing here reads the whole cluster.
    const namespaces = new Map<string, { database: string; collection: string }>();
    for (const row of page) {
      namespaces.set(`${row.database} ${row.collection}`, {
        database: row.database,
        collection: row.collection,
      });
    }
    const links = await this.repo.liveRecommendationsFor(clusterId, [...namespaces.values()]);
    const linkByIndex = new Map<string, IndexRecommendationLink>();
    for (const rec of links) {
      const link = { id: rec.id, type: rec.type, state: rec.state };
      // A drop names the index it removes, so its own `index_name` is the one on
      // screen. A build names the index it would CREATE, which does not exist
      // yet and matches nothing here — but a REORDER or a narrowing UPDATE also
      // RETIRES an existing index, and that one does. Retiring an index is a
      // decision about the index being retired, so the row it belongs on is that
      // one rather than none.
      for (const name of [rec.indexName, ...(rec.targetSpec?.retire ?? [])]) {
        const key = `${rec.database} ${rec.collection} ${name}`;
        // First writer wins. Two live rows cannot both claim one index — the
        // partial unique index recommendations_one_live_claim forbids it for the
        // types that make the same claim — but a REORDER retiring the index a
        // DROP also names is reachable, and the page needs one link rather than
        // a rule about which.
        if (!linkByIndex.has(key)) linkByIndex.set(key, link);
      }
    }

    return {
      clusterId,
      indexes: page.map((row) => {
        const spec = parseStoredSpec(row.spec);
        const perMember = row.perMember.map((entry) => ({
          member: entry.member,
          ops: entry.ops,
          // Validated rather than forwarded. The value is an adapter's string
          // and one of them falls back to "" when the server did not answer the
          // identity query (postgres/connection.ts) — an empty string is not an
          // instant, and forwarding it would fail the contract's output
          // validation and take the whole page down over one member's unknown
          // counter start. Unknown is what null means here.
          since: instant.safeParse(entry.since).success ? (entry.since ?? null) : null,
        }));
        return {
          id: row.id,
          database: row.database,
          collection: row.collection,
          indexName: row.indexName,
          keys: spec.keys.map((key) => ({ field: key.field, direction: key.direction })),
          include: [...(spec.include ?? [])],
          unique: spec.unique,
          ttl: spec.ttl,
          partial: spec.partial,
          partialFilter: spec.partialFilter,
          sparse: spec.sparse,
          hidden: spec.hidden,
          isShardKey: spec.isShardKey,
          collation: spec.collation,
          hinted: row.hinted,
          sizeBytes: row.sizeBytes,
          // Summed over the members that ANSWERED, which is the only total that
          // can be honestly stated: a member the collect could not reach is not
          // in `per_member` at all, and the roster read beside this page is what
          // names it rather than counting it as a zero (D66).
          totalOps: perMember.reduce((sum, entry) => sum + entry.ops, 0),
          perMember,
          observedAt: row.lastSeenAt.toISOString(),
          recommendation:
            linkByIndex.get(`${row.database} ${row.collection} ${row.indexName}`) ?? null,
        };
      }),
      total,
      // Null at the end, so the page stops offering "more" rather than fetching
      // an empty one to discover the end.
      nextDatabase: more && last !== undefined ? last.database : null,
      nextCollection: more && last !== undefined ? last.collection : null,
      nextIndexName: more && last !== undefined ? last.indexName : null,
      collectedAt: collectedAt.toISOString(),
    };
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
