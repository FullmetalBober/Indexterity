import { Controller, Req } from "@nestjs/common";
import { implement } from "@orpc/nest";
import type { RoiContribution } from "@repo/contracts";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import {
  type LatencyReading,
  latencyPoints,
  monthlySavingsUsd,
  summarizeLatency,
} from "../analysis";
import {
  actions,
  and,
  desc,
  eq,
  inArray,
  indexSnapshots,
  latencySamples,
  recommendations,
  roiMetrics,
  sql,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { TenancyService } from "../http/tenancy.service";
import { Implement } from "../orpc/implement";

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
  ): Promise<Map<string, { database: string; collection: string; readings: LatencyReading[] }>> {
    const rows = await this.database.db
      .select()
      .from(latencySamples)
      .where(eq(latencySamples.clusterId, clusterId));
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
      group.readings.push({
        readOps: row.readOps,
        readLatencyMicros: row.readLatencyMicros,
        writeOps: row.writeOps,
        writeLatencyMicros: row.writeLatencyMicros,
        capturedAt: row.capturedAt.toISOString(),
      });
      groups.set(key, group);
    }
    return groups;
  }

  @Implement(contract.getRoi)
  getRoi(@Req() req: FastifyRequest) {
    return implement(contract.getRoi).handler(async ({ input }) => {
      const orgId = await this.tenancy.org(req);
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
      const envRate = Number(process.env.STORAGE_USD_PER_GB_MONTH);
      const rate = Number.isFinite(envRate) && envRate > 0 ? envRate : undefined;
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
    });
  }

  @Implement(contract.getLatency)
  getLatency(@Req() req: FastifyRequest) {
    return implement(contract.getLatency).handler(async ({ input }) => {
      const orgId = await this.tenancy.org(req);
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
    });
  }

  @Implement(contract.getLatencySeries)
  getLatencySeries(@Req() req: FastifyRequest) {
    return implement(contract.getLatencySeries).handler(async ({ input }) => {
      const orgId = await this.tenancy.org(req);
      if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
        return { clusterId: input.clusterId, collections: [] };
      }
      const groups = await this.loadLatencyReadings(input.clusterId);
      const collections = [...groups.values()].map((group) => ({
        database: group.database,
        collection: group.collection,
        points: latencyPoints(group.readings),
      }));
      return { clusterId: input.clusterId, collections };
    });
  }

  // Per-collection index footprint from the latest snapshot batch (one collect
  // run inserts all its rows in a single statement, so they share a timestamp).
  @Implement(contract.getCollections)
  getCollections(@Req() req: FastifyRequest) {
    return implement(contract.getCollections).handler(async ({ input }) => {
      const orgId = await this.tenancy.org(req);
      if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
        return { clusterId: input.clusterId, collections: [] };
      }
      // The max(captured_at) comparison must stay in SQL: pg keeps microseconds
      // and a JS Date round-trip truncates to ms, so re-querying by an equal
      // Date would match nothing.
      const snapshotRows = await this.database.db
        .select()
        .from(indexSnapshots)
        .where(
          and(
            eq(indexSnapshots.clusterId, input.clusterId),
            sql`${indexSnapshots.capturedAt} = (select max(${indexSnapshots.capturedAt}) from ${indexSnapshots} where ${indexSnapshots.clusterId} = ${input.clusterId})`,
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
    });
  }

  @Implement(contract.listActions)
  listActions(@Req() req: FastifyRequest) {
    return implement(contract.listActions).handler(async ({ input }) => {
      const orgId = await this.tenancy.org(req);
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
    });
  }

  // Seal a connection string and insert the cluster row (read-only by default).
}
