import { ORPCError } from "@orpc/server";
import type { Cluster, Recommendation } from "@repo/contracts";
import { clusters, recommendations } from "../db";
import type { ConnectionDiagnosis as EngineConnectionDiagnosis } from "../engine/ports";
import { isUnreachableError } from "../errors/unreachable";

// Shared boundary conversions and error mapping. Every controller that touches
// a customer cluster maps failures the same way, and the contract types differ
// from the row types in the same two ways everywhere.

// oRPC handles handler throws itself (Nest filters never see them), so the
// customer-cluster failure mapping lives here: unreachable -> 502 with guidance.
export function mapClusterError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  const err = error instanceof Error ? error : new Error(String(error));
  if (isUnreachableError(err)) {
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

// The domain type carries readonly arrays; the contract's output schema wants
// plain ones. Copy at the boundary rather than loosening the domain type.
export function toDiagnosis(diagnosis: EngineConnectionDiagnosis) {
  return {
    ...diagnosis,
    privileges: [...diagnosis.privileges],
    missing: [...diagnosis.missing],
  };
}

export function toCluster(
  row: typeof clusters.$inferSelect,
  lastCollectedAt: Date | null = null,
): Cluster {
  return {
    id: row.id,
    name: row.name,
    connectionMode: row.connectionMode,
    engine: row.engine,
    readOnly: row.readOnly,
    provisionedUsername: row.provisionedUsername,
    lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRecommendation(row: typeof recommendations.$inferSelect): Recommendation {
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
