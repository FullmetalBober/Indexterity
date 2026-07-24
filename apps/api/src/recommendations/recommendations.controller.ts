import { Controller } from "@nestjs/common";
import { type Cluster, contract, type Recommendation } from "@repo/contracts";
import { clusters, desc, eq, recommendations } from "@repo/db";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import { DatabaseService } from "../db/database.service";

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
