import { Controller, Req, UnauthorizedException } from "@nestjs/common";
import { type Cluster, contract, type Recommendation } from "@repo/contracts";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type LatencyReading,
  monthlySavingsUsd,
  parseStoredSpec,
  rebuildKeys,
  summarizeLatency,
} from "../analysis";
import { auth } from "../auth";
import { toWebHeaders } from "../auth/http";
import { resolveOrgId } from "../auth/tenancy";
import {
  actions,
  and,
  clusters,
  desc,
  envKeyProvider,
  eq,
  latencySamples,
  recommendations,
  roiMetrics,
  seal,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { masterKeyBytes } from "../env";
import { classifyCluster } from "../jobs/classify";
import { openClusterMongo } from "../jobs/cluster-connection";
import { collectCluster } from "../jobs/collect";
import { MongoIndexExecutor } from "../mongo";

// A drop's rollback token carries the dropped index's serialized spec.
const rollbackTokenSchema = z.object({ spec: z.unknown() });

function toCluster(row: typeof clusters.$inferSelect): Cluster {
  return {
    id: row.id,
    name: row.name,
    connectionMode: row.connectionMode,
    demoMode: row.demoMode,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRecommendation(row: typeof recommendations.$inferSelect): Recommendation {
  return {
    id: row.id,
    clusterId: row.clusterId,
    type: row.type,
    usageClass: row.usageClass,
    state: row.state,
    database: row.database,
    collection: row.collection,
    indexName: row.indexName,
    rationale: row.rationale,
    estimatedBytesSaved: row.estimatedBytesSaved,
    createdAt: row.createdAt.toISOString(),
  };
}

// Serves the shared ts-rest contract from Postgres. Every endpoint requires a
// better-auth session and is scoped to the caller's org.
@Controller()
export class RecommendationsController {
  constructor(private readonly database: DatabaseService) {}

  // Authn + tenancy: 401 without a valid session, else the caller's org id.
  private async resolveOrg(req: FastifyRequest): Promise<string> {
    const session = await auth.api.getSession({ headers: toWebHeaders(req.headers) });
    if (session === null) throw new UnauthorizedException();
    return resolveOrgId(this.database.db, session.user.id);
  }

  private async ownsCluster(clusterId: string, orgId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(and(eq(clusters.id, clusterId), eq(clusters.orgId, orgId)))
      .limit(1);
    return row !== undefined;
  }

  @TsRestHandler(contract.listClusters)
  listClusters(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.listClusters, async () => {
      const orgId = await this.resolveOrg(req);
      const rows = await this.database.db
        .select()
        .from(clusters)
        .where(eq(clusters.orgId, orgId))
        .orderBy(desc(clusters.createdAt));
      return { status: 200, body: rows.map(toCluster) };
    });
  }

  @TsRestHandler(contract.listRecommendations)
  listRecommendations(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.listRecommendations, async ({ params }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(params.clusterId, orgId))) return { status: 200, body: [] };
      const rows = await this.database.db
        .select()
        .from(recommendations)
        .where(eq(recommendations.clusterId, params.clusterId));
      return { status: 200, body: rows.map(toRecommendation) };
    });
  }

  @TsRestHandler(contract.getRoi)
  getRoi(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.getRoi, async ({ params }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(params.clusterId, orgId))) {
        return {
          status: 200,
          body: { clusterId: params.clusterId, freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0 },
        };
      }
      const rows = await this.database.db
        .select()
        .from(roiMetrics)
        .where(eq(roiMetrics.clusterId, params.clusterId));
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
      const estimatedMonthlyUsd = monthlySavingsUsd(
        freedBytes,
        Number.isFinite(envRate) && envRate > 0 ? envRate : undefined,
      );
      return {
        status: 200,
        body: { clusterId: params.clusterId, freedBytes, indexesDropped, estimatedMonthlyUsd },
      };
    });
  }

  @TsRestHandler(contract.getLatency)
  getLatency(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.getLatency, async ({ params }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(params.clusterId, orgId))) {
        return { status: 200, body: { clusterId: params.clusterId, collections: [] } };
      }
      const rows = await this.database.db
        .select()
        .from(latencySamples)
        .where(eq(latencySamples.clusterId, params.clusterId));
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
      const collections = [...groups.values()].map((group) => ({
        database: group.database,
        collection: group.collection,
        ...summarizeLatency(group.readings),
      }));
      return { status: 200, body: { clusterId: params.clusterId, collections } };
    });
  }

  @TsRestHandler(contract.createCluster)
  createCluster(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.createCluster, async ({ body }) => {
      const orgId = await this.resolveOrg(req);
      const sealed = await seal(
        new TextEncoder().encode(body.connectionString),
        envKeyProvider(masterKeyBytes()),
      );
      const [row] = await this.database.db
        .insert(clusters)
        .values({
          orgId,
          name: body.name,
          connectionMode: "HOSTED_DIRECT",
          demoMode: true,
          sealedDek: Buffer.from(sealed.dek),
          sealedData: Buffer.from(sealed.data),
        })
        .returning();
      if (row === undefined) throw new Error("failed to create cluster");
      return { status: 200, body: toCluster(row) };
    });
  }

  @TsRestHandler(contract.triggerCollect)
  triggerCollect(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.triggerCollect, async ({ params }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(params.clusterId, orgId))) {
        return { status: 404, body: { message: "cluster not found" } };
      }
      const snapshots = await collectCluster(params.clusterId);
      const recommendationCount = await classifyCluster(params.clusterId);
      return { status: 200, body: { snapshots, recommendations: recommendationCount } };
    });
  }

  @TsRestHandler(contract.approveRecommendation)
  approveRecommendation(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.approveRecommendation, async ({ params }) => {
      const orgId = await this.resolveOrg(req);
      const [owned] = await this.database.db
        .select({ id: recommendations.id })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, params.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        return { status: 404, body: { message: "recommendation not found" } };
      }
      const [row] = await this.database.db
        .update(recommendations)
        .set({ state: "APPROVED", updatedAt: new Date() })
        .where(eq(recommendations.id, params.id))
        .returning();
      if (row === undefined) {
        return { status: 404, body: { message: "recommendation not found" } };
      }
      return { status: 200, body: toRecommendation(row) };
    });
  }

  // Undo a drop: rebuild the index from the spec captured at drop time, correct
  // the ROI headline with a negative row, and mark the recommendation ROLLED_BACK.
  @TsRestHandler(contract.rollbackRecommendation)
  rollbackRecommendation(@Req() req: FastifyRequest) {
    return tsRestHandler(contract.rollbackRecommendation, async ({ params }) => {
      const orgId = await this.resolveOrg(req);
      const [owned] = await this.database.db
        .select({ rec: recommendations })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, params.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        return { status: 404, body: { message: "recommendation not found" } };
      }
      const rec = owned.rec;
      if (rec.state !== "DROPPED") {
        return { status: 409, body: { message: "only a dropped index can be undone" } };
      }
      const dropActions = await this.database.db
        .select()
        .from(actions)
        .where(and(eq(actions.recommendationId, rec.id), eq(actions.kind, "DROP")))
        .orderBy(desc(actions.createdAt));
      const withToken = dropActions.find((action) => action.rollbackToken !== null);
      if (withToken === undefined || withToken.rollbackToken === null) {
        return { status: 409, body: { message: "no rollback token recorded for this drop" } };
      }
      let keys: Record<string, 1 | -1> | null = null;
      let indexName = rec.indexName;
      try {
        const spec = parseStoredSpec(rollbackTokenSchema.parse(withToken.rollbackToken).spec);
        keys = rebuildKeys(spec);
        indexName = spec.name;
      } catch {
        keys = null;
      }
      if (keys === null) {
        return { status: 409, body: { message: "stored spec cannot be rebuilt automatically" } };
      }
      const { conn, demoMode } = await openClusterMongo(this.database.db, rec.clusterId);
      try {
        if (demoMode) {
          return { status: 409, body: { message: "cluster is in demo mode" } };
        }
        const executor = new MongoIndexExecutor(conn, demoMode);
        await executor.create(rec.database, rec.collection, keys, { name: indexName });
      } finally {
        await conn.close();
      }
      // The freed bytes are spent again — correct the ROI headline.
      await this.database.db.insert(roiMetrics).values({
        clusterId: rec.clusterId,
        freedBytes: -rec.estimatedBytesSaved,
        indexCountDelta: -1,
        periodStart: new Date(),
        periodEnd: new Date(),
      });
      const [updated] = await this.database.db
        .update(recommendations)
        .set({ state: "ROLLED_BACK", updatedAt: new Date() })
        .where(eq(recommendations.id, rec.id))
        .returning();
      if (updated === undefined) {
        return { status: 404, body: { message: "recommendation not found" } };
      }
      await this.database.db.insert(actions).values({
        recommendationId: rec.id,
        kind: "ROLLBACK",
        actor: "user",
        result: "ok",
      });
      return { status: 200, body: toRecommendation(updated) };
    });
  }
}
