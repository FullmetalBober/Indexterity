import { Controller } from "@nestjs/common";
import { type Cluster, contract, type Recommendation } from "@repo/contracts";
import {
  clusters,
  type Database,
  desc,
  envKeyProvider,
  eq,
  organizations,
  recommendations,
  roiMetrics,
  seal,
} from "@repo/db";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import { DatabaseService } from "../db/database.service";
import { masterKeyBytes } from "../env";
import { classifyCluster } from "../jobs/classify";
import { collectCluster } from "../jobs/collect";

// First org (or create a default). Real multi-tenant would use the session org.
async function firstOrgId(db: Database): Promise<string> {
  const [existing] = await db.select({ id: organizations.id }).from(organizations).limit(1);
  if (existing !== undefined) return existing.id;
  const [created] = await db
    .insert(organizations)
    .values({ name: "Default Org" })
    .returning({ id: organizations.id });
  if (created === undefined) throw new Error("failed to create organization");
  return created.id;
}

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

// Serves the shared ts-rest contract from Postgres.
@Controller()
export class RecommendationsController {
  constructor(private readonly database: DatabaseService) {}

  @TsRestHandler(contract.listClusters)
  listClusters() {
    return tsRestHandler(contract.listClusters, async () => {
      const rows = await this.database.db.select().from(clusters).orderBy(desc(clusters.createdAt));
      return { status: 200, body: rows.map(toCluster) };
    });
  }

  @TsRestHandler(contract.listRecommendations)
  listRecommendations() {
    return tsRestHandler(contract.listRecommendations, async ({ params }) => {
      const rows = await this.database.db
        .select()
        .from(recommendations)
        .where(eq(recommendations.clusterId, params.clusterId));
      return { status: 200, body: rows.map(toRecommendation) };
    });
  }

  @TsRestHandler(contract.getRoi)
  getRoi() {
    return tsRestHandler(contract.getRoi, async ({ params }) => {
      const rows = await this.database.db
        .select()
        .from(roiMetrics)
        .where(eq(roiMetrics.clusterId, params.clusterId));
      const freedBytes = rows.reduce((sum, row) => sum + row.freedBytes, 0);
      const indexesDropped = rows.reduce((sum, row) => sum + row.indexCountDelta, 0);
      return { status: 200, body: { clusterId: params.clusterId, freedBytes, indexesDropped } };
    });
  }

  @TsRestHandler(contract.createCluster)
  createCluster() {
    return tsRestHandler(contract.createCluster, async ({ body }) => {
      const orgId = await firstOrgId(this.database.db);
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
  triggerCollect() {
    return tsRestHandler(contract.triggerCollect, async ({ params }) => {
      const [cluster] = await this.database.db
        .select({ id: clusters.id })
        .from(clusters)
        .where(eq(clusters.id, params.clusterId))
        .limit(1);
      if (cluster === undefined) return { status: 404, body: { message: "cluster not found" } };
      const snapshots = await collectCluster(params.clusterId);
      const recommendationCount = await classifyCluster(params.clusterId);
      return { status: 200, body: { snapshots, recommendations: recommendationCount } };
    });
  }

  @TsRestHandler(contract.approveRecommendation)
  approveRecommendation() {
    return tsRestHandler(contract.approveRecommendation, async ({ params }) => {
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
}
