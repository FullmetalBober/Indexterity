import { Controller, Req } from "@nestjs/common";
import { Implement, implement } from "@orpc/nest";
import { ORPCError } from "@orpc/server";
import { type Cluster, contract, type Recommendation } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type LatencyReading,
  latencyPoints,
  monthlySavingsUsd,
  parseStoredSpec,
  rebuildKeys,
  summarizeLatency,
} from "../analysis";
import { requireUserId } from "../auth/session";
import { type Membership, resolveMembership } from "../auth/tenancy";
import {
  actions,
  and,
  clusters,
  desc,
  envKeyProvider,
  eq,
  latencySamples,
  policies,
  recommendations,
  roiMetrics,
  seal,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { currentKeyVersion, masterKeyBytesFor } from "../env";
import { classifyCluster } from "../jobs/classify";
import { openClusterMongo } from "../jobs/cluster-connection";
import { collectCluster } from "../jobs/collect";
import { MongoIndexExecutor } from "../mongo";
import { isMongoConnString } from "../mongo/conn-string";

// A drop's rollback token carries the dropped index's serialized spec.
const rollbackTokenSchema = z.object({ spec: z.unknown() });

const UNREACHABLE_NAME = /MongoServerSelectionError|MongoNetworkError|MongoTimeoutError/;
const UNREACHABLE_MESSAGE = /getaddrinfo|ECONNREFUSED|ETIMEDOUT|Server selection timed out/i;

// oRPC handles handler throws itself (Nest filters never see them), so the
// customer-cluster failure mapping lives here: unreachable -> 502 with guidance.
function mapClusterError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  const err = error instanceof Error ? error : new Error(String(error));
  if (UNREACHABLE_NAME.test(err.name) || UNREACHABLE_MESSAGE.test(err.message)) {
    throw new ORPCError("CLUSTER_UNREACHABLE", {
      status: 502,
      message: "cluster unreachable — check the connection string and network access",
    });
  }
  if (err.message.startsWith("cluster not found")) {
    throw new ORPCError("NOT_FOUND", { message: "cluster not found" });
  }
  throw err;
}

function toCluster(row: typeof clusters.$inferSelect): Cluster {
  return {
    id: row.id,
    name: row.name,
    connectionMode: row.connectionMode,
    readOnly: row.readOnly,
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
    score: row.score,
    estimatedBytesSaved: row.estimatedBytesSaved,
    createdAt: row.createdAt.toISOString(),
  };
}

// Serves the shared oRPC contract from Postgres. Every endpoint requires a
// better-auth session and is scoped to the caller's org.
@Controller()
export class RecommendationsController {
  constructor(private readonly database: DatabaseService) {}

  // Authn + tenancy: 401 without a valid session, else the caller's membership.
  private async resolveMember(req: FastifyRequest): Promise<Membership> {
    return resolveMembership(this.database.db, await requireUserId(req));
  }

  private async resolveOrg(req: FastifyRequest): Promise<string> {
    return (await this.resolveMember(req)).orgId;
  }

  // Mutations (connect cluster, mode, approve, undo, collect) are owner-only;
  // members read everything.
  private async requireOwner(req: FastifyRequest): Promise<string> {
    const member = await this.resolveMember(req);
    if (member.role !== "owner") {
      throw new ORPCError("FORBIDDEN", { message: "owner role required" });
    }
    return member.orgId;
  }

  private async ownsCluster(clusterId: string, orgId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(and(eq(clusters.id, clusterId), eq(clusters.orgId, orgId)))
      .limit(1);
    return row !== undefined;
  }

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

  @Implement(contract.listClusters)
  listClusters(@Req() req: FastifyRequest) {
    return implement(contract.listClusters).handler(async () => {
      const orgId = await this.resolveOrg(req);
      const rows = await this.database.db
        .select()
        .from(clusters)
        .where(eq(clusters.orgId, orgId))
        .orderBy(desc(clusters.createdAt));
      return rows.map(toCluster);
    });
  }

  @Implement(contract.listRecommendations)
  listRecommendations(@Req() req: FastifyRequest) {
    return implement(contract.listRecommendations).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) return [];
      const rows = await this.database.db
        .select()
        .from(recommendations)
        .where(eq(recommendations.clusterId, input.clusterId));
      return rows.map(toRecommendation);
    });
  }

  @Implement(contract.getRoi)
  getRoi(@Req() req: FastifyRequest) {
    return implement(contract.getRoi).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        return {
          clusterId: input.clusterId,
          freedBytes: 0,
          indexesDropped: 0,
          estimatedMonthlyUsd: 0,
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
      const estimatedMonthlyUsd = monthlySavingsUsd(
        freedBytes,
        Number.isFinite(envRate) && envRate > 0 ? envRate : undefined,
      );
      return { clusterId: input.clusterId, freedBytes, indexesDropped, estimatedMonthlyUsd };
    });
  }

  @Implement(contract.getLatency)
  getLatency(@Req() req: FastifyRequest) {
    return implement(contract.getLatency).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
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
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
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

  @Implement(contract.listActions)
  listActions(@Req() req: FastifyRequest) {
    return implement(contract.listActions).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) return [];
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

  @Implement(contract.createCluster)
  createCluster(@Req() req: FastifyRequest) {
    return implement(contract.createCluster).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      if (!isMongoConnString(input.connectionString)) {
        throw errors.BAD_REQUEST({
          message: "connection string must be mongodb:// or mongodb+srv://",
        });
      }
      const keyVersion = currentKeyVersion();
      const sealed = await seal(
        new TextEncoder().encode(input.connectionString),
        envKeyProvider(masterKeyBytesFor(keyVersion)),
      );
      const [row] = await this.database.db
        .insert(clusters)
        .values({
          orgId,
          name: input.name,
          connectionMode: "HOSTED_DIRECT",
          readOnly: true,
          sealedDek: Buffer.from(sealed.dek),
          sealedData: Buffer.from(sealed.data),
          keyVersion,
        })
        .returning();
      if (row === undefined) throw new Error("failed to create cluster");
      return toCluster(row);
    });
  }

  // Owner-only: flip a cluster between read-only and live mode.
  @Implement(contract.setClusterMode)
  setClusterMode(@Req() req: FastifyRequest) {
    return implement(contract.setClusterMode).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const [row] = await this.database.db
        .update(clusters)
        .set({ readOnly: input.readOnly })
        .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
        .returning();
      if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
      return toCluster(row);
    });
  }

  @Implement(contract.getPolicy)
  getPolicy(@Req() req: FastifyRequest) {
    return implement(contract.getPolicy).handler(async ({ input, errors }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      const [row] = await this.database.db
        .select()
        .from(policies)
        .where(eq(policies.clusterId, input.clusterId))
        .limit(1);
      return {
        clusterId: input.clusterId,
        autoApply: row?.autoApply ?? false,
        workloadAnalysis: row?.workloadAnalysis ?? false,
        instantCreate: row?.instantCreate ?? false,
        observeWindowDays: row?.observeWindowDays ?? 30,
        maxCollectionSizeBytes: row?.maxCollectionSizeBytes ?? null,
        autoApplyScore: row?.autoApplyScore ?? null,
      };
    });
  }

  // Owner-only: replace the cluster's engine knobs.
  @Implement(contract.updatePolicy)
  updatePolicy(@Req() req: FastifyRequest) {
    return implement(contract.updatePolicy).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const { clusterId, ...knobs } = input;
      if (!(await this.ownsCluster(clusterId, orgId))) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      await this.database.db
        .insert(policies)
        .values({ clusterId, ...knobs })
        .onConflictDoUpdate({ target: policies.clusterId, set: knobs });
      return { clusterId, ...knobs };
    });
  }

  @Implement(contract.triggerCollect)
  triggerCollect(@Req() req: FastifyRequest) {
    return implement(contract.triggerCollect).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      try {
        const snapshots = await collectCluster(input.clusterId);
        const recommendationCount = await classifyCluster(input.clusterId);
        return { snapshots, recommendations: recommendationCount };
      } catch (error) {
        mapClusterError(error);
      }
    });
  }

  @Implement(contract.approveRecommendation)
  approveRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.approveRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const [owned] = await this.database.db
        .select({ id: recommendations.id })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      const [row] = await this.database.db
        .update(recommendations)
        .set({ state: "APPROVED", updatedAt: new Date() })
        .where(eq(recommendations.id, input.id))
        .returning();
      if (row === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      return toRecommendation(row);
    });
  }

  // Undo a drop: rebuild the index from the spec captured at drop time, correct
  // the ROI headline with a negative row, and mark the recommendation ROLLED_BACK.
  @Implement(contract.rollbackRecommendation)
  rollbackRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.rollbackRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const [owned] = await this.database.db
        .select({ rec: recommendations })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      const rec = owned.rec;
      if (rec.state !== "DROPPED") {
        throw errors.CONFLICT({ message: "only a dropped index can be undone" });
      }
      const dropActions = await this.database.db
        .select()
        .from(actions)
        .where(and(eq(actions.recommendationId, rec.id), eq(actions.kind, "DROP")))
        .orderBy(desc(actions.createdAt));
      const withToken = dropActions.find((action) => action.rollbackToken !== null);
      if (withToken === undefined || withToken.rollbackToken === null) {
        throw errors.CONFLICT({ message: "no rollback token recorded for this drop" });
      }
      let keys: Record<string, 1 | -1> | null = null;
      let indexName = rec.indexName;
      let collation: string | null = null;
      try {
        const spec = parseStoredSpec(rollbackTokenSchema.parse(withToken.rollbackToken).spec);
        keys = rebuildKeys(spec);
        indexName = spec.name;
        collation = spec.collation;
      } catch {
        keys = null;
      }
      if (keys === null) {
        throw errors.CONFLICT({ message: "stored spec cannot be rebuilt automatically" });
      }
      try {
        const { conn, readOnly, release } = await openClusterMongo(
          this.database.db,
          rec.clusterId,
        );
        try {
          if (readOnly) {
            throw errors.CONFLICT({ message: "cluster is read-only" });
          }
          const executor = new MongoIndexExecutor(conn, readOnly);
          await executor.create(rec.database, rec.collection, keys, {
            name: indexName,
            ...(collation === null ? {} : { collation: { locale: collation } }),
          });
        } finally {
          release();
        }
      } catch (error) {
        mapClusterError(error);
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
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      await this.database.db.insert(actions).values({
        recommendationId: rec.id,
        kind: "ROLLBACK",
        actor: "user",
        result: "ok",
      });
      return toRecommendation(updated);
    });
  }
}
