import { ORPCError } from "@orpc/server";
import type { Cluster, ClusterEngine, Recommendation } from "@repo/contracts";
import { DEFAULT_OBSERVE_DAYS, proposedVetoDays } from "../analysis";
import { clusters, recommendations } from "../db";
import type { ConnectionDiagnosis as EngineConnectionDiagnosis } from "../engine/ports";
import { revokeCommandFor } from "../engine/provision";
import { isUnreachableError } from "../errors/unreachable";
import { ClusterGoneError } from "../jobs/cluster-connection";

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
  if (err instanceof ClusterGoneError) {
    throw new ORPCError("NOT_FOUND", { message: "cluster not found" });
  }
  throw err;
}

// The domain type carries readonly arrays; the contract's output schema wants
// plain ones. Copy at the boundary rather than loosening the domain type.
// The engine is passed rather than read off the diagnosis: the adapters answer
// about the CONNECTION, and which adapter was asked is the caller's own decision
// (an explicit override, or what the string detected as). The form needs it back
// to say what it will connect as, so the answer carries the question (#239).
export function toDiagnosis(engine: ClusterEngine, diagnosis: EngineConnectionDiagnosis) {
  return {
    ...diagnosis,
    engine,
    privileges: [...diagnosis.privileges],
    surplus: [...diagnosis.surplus],
    missing: [...diagnosis.missing],
    databases: [...diagnosis.databases],
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
    tunnelId: row.tunnelId,
    provisionedUsername: row.provisionedUsername,
    revokeCommand: revokeCommandFor(row.engine, row.provisionedUsername, row.provisionedDatabases),
    credentialPosture: row.credentialPosture,
    lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
    // Four columns, one field: a reason with no start and no sentence is not
    // something a screen can say anything useful with, so they travel together
    // or not at all.
    //
    // The pass is the exception and stays nullable rather than joining that
    // rule (#408) — a block written before the column existed has none, and it
    // is still a perfectly good block. What the screen loses is the ability to
    // name the pass, which is what it did for every block until now.
    blocked:
      row.blockedReason === null || row.blockedSince === null
        ? null
        : {
            reason: row.blockedReason,
            since: row.blockedSince.toISOString(),
            detail: row.blockedDetail ?? "",
            task: row.blockedTask,
          },
    tlsOverrides: row.tlsOverrides,
    observedDatabases: row.observedDatabases,
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
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    observeDays: row.observeDays,
    // The engine's own first-retry span for this row's window, so the cancel
    // dialog shows the engine's opinion rather than a round number (D136).
    proposedCooldownDays: proposedVetoDays(row.observeDays ?? DEFAULT_OBSERVE_DAYS),
    observeReason: row.observeReason,
    createdAt: row.createdAt.toISOString(),
  };
}
