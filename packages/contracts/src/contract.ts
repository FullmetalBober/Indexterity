import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  auditAction,
  cluster,
  clusterLatency,
  clusterLatencySeries,
  clusterPolicy,
  clusterRoi,
  createdInvite,
  orgInfo,
  provisionedCluster,
  recommendation,
} from "./schemas.js";

const clusterId = z.object({ clusterId: z.uuid() });

// Typed contract shared by api (server, @orpc/nest @Implement) and web (client,
// OpenAPILink). Paths are stable — the integration suite and any external
// caller rely on them. Path params ({name}) live in the input schema; the
// remaining input fields become the query (GET) or body (other methods).
export const contract = {
  listClusters: oc
    .route({ method: "GET", path: "/clusters", summary: "List connected clusters" })
    .output(z.array(cluster)),

  listRecommendations: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/recommendations",
      summary: "List recommendations for a cluster",
    })
    .input(clusterId)
    .output(z.array(recommendation)),

  getRoi: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/roi",
      summary: "Realized ROI for a cluster (freed bytes, indexes dropped, $/mo)",
    })
    .input(clusterId)
    .output(clusterRoi),

  getLatency: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/latency",
      summary: "Per-collection read/write latency trend (before/after)",
    })
    .input(clusterId)
    .output(clusterLatency),

  getLatencySeries: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/latency-series",
      summary: "Per-collection windowed latency time series (µs per op)",
    })
    .input(clusterId)
    .output(clusterLatencySeries),

  listActions: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/actions",
      summary: "The cluster's audit trail (latest 50 executed operations)",
    })
    .input(clusterId)
    .output(z.array(auditAction)),

  createCluster: oc
    .route({
      method: "POST",
      path: "/clusters",
      summary: "Connect a cluster; stores its connection string envelope-encrypted",
    })
    .errors({ BAD_REQUEST: {} })
    .input(z.object({ name: z.string().min(1), connectionString: z.string().min(1) }))
    .output(cluster),

  provisionCluster: oc
    .route({
      method: "POST",
      path: "/clusters/provision",
      summary:
        "Connect with an admin string used ONCE: creates a least-privilege user on the cluster and stores only that user's string",
    })
    .errors({ BAD_REQUEST: {} })
    .input(z.object({ name: z.string().min(1), adminConnectionString: z.string().min(1) }))
    .output(provisionedCluster),

  setClusterMode: oc
    .route({
      method: "PATCH",
      path: "/clusters/{clusterId}/mode",
      summary: "Toggle read-only mode (owner only) — live mode lets the engine write",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId.extend({ readOnly: z.boolean() }))
    .output(cluster),

  getPolicy: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/policy",
      summary: "The cluster's engine knobs (defaults when never configured)",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId)
    .output(clusterPolicy),

  updatePolicy: oc
    .route({
      method: "PUT",
      path: "/clusters/{clusterId}/policy",
      summary: "Replace the cluster's engine knobs (owner only)",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId.extend(clusterPolicy.omit({ clusterId: true }).shape))
    .output(clusterPolicy),

  triggerCollect: oc
    .route({
      method: "POST",
      path: "/clusters/{clusterId}/collect",
      summary: "Collect + classify a cluster now",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId)
    .output(z.object({ snapshots: z.int(), recommendations: z.int() })),

  approveRecommendation: oc
    .route({
      method: "POST",
      path: "/recommendations/{id}/approve",
      summary: "Approve a recommendation, moving it into the apply pipeline",
    })
    .errors({ NOT_FOUND: {} })
    .input(z.object({ id: z.uuid() }))
    .output(recommendation),

  rollbackRecommendation: oc
    .route({
      method: "POST",
      path: "/recommendations/{id}/rollback",
      summary: "Undo a drop: rebuild the index from its rollback token",
    })
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .input(z.object({ id: z.uuid() }))
    .output(recommendation),

  getOrg: oc
    .route({
      method: "GET",
      path: "/org",
      summary: "The caller's org: members and pending invites",
    })
    .output(orgInfo),

  createInvite: oc
    .route({
      method: "POST",
      path: "/org/invites",
      summary: "Invite someone into the org; returns the one-time token",
    })
    .input(z.object({ email: z.email(), role: z.enum(["member", "owner"]) }))
    .output(createdInvite),

  acceptInvite: oc
    .route({ method: "POST", path: "/invites/accept", summary: "Join an org with an invite token" })
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .input(z.object({ token: z.string().min(1) }))
    .output(z.object({ orgId: z.uuid(), orgName: z.string() })),
};
