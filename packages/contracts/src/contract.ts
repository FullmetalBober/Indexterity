import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  acceptInviteInput,
  checkConnectionInput,
  createClusterInput,
  createInviteInput,
  memberRole,
  policyKnobsInput,
  provisionClusterInput,
  renameOrgInput,
  rotateConnectionInput,
} from "./inputs.js";
import {
  auditAction,
  cluster,
  clusterCollections,
  clusterLatency,
  clusterLatencySeries,
  clusterPolicyView,
  clusterRoi,
  connectionDiagnosis,
  createdInvite,
  offboardResult,
  orgInfo,
  orgSummary,
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

  getCollections: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/collections",
      summary: "Per-collection index footprint from the latest snapshot batch",
    })
    .input(clusterId)
    .output(clusterCollections),

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
    .input(createClusterInput)
    .output(cluster),

  checkConnection: oc
    .route({
      method: "POST",
      path: "/clusters/check-connection",
      summary:
        "Report what a connection string may do (owner only) — nothing is stored or written; the onboarding preflight",
    })
    .errors({ BAD_REQUEST: {} })
    .input(checkConnectionInput)
    .output(connectionDiagnosis),

  provisionCluster: oc
    .route({
      method: "POST",
      path: "/clusters/provision",
      summary:
        "Connect with an admin string used ONCE: creates a least-privilege user on the cluster and stores only that user's string",
    })
    .errors({ BAD_REQUEST: {} })
    .input(provisionClusterInput)
    .output(provisionedCluster),

  deleteCluster: oc
    .route({
      method: "DELETE",
      path: "/clusters/{clusterId}",
      summary:
        "Disconnect a cluster (owner only): restore in-flight hidden indexes, delete all collected data, return the user-revoke command",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId)
    .output(offboardResult),

  rotateConnection: oc
    .route({
      method: "PATCH",
      path: "/clusters/{clusterId}/connection",
      summary:
        "Replace the cluster's connection string (owner only) — verified against the cluster before it is stored, so history survives credential rotation",
    })
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {} })
    .input(clusterId.extend(rotateConnectionInput.shape))
    .output(cluster),

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
    .output(clusterPolicyView),

  updatePolicy: oc
    .route({
      method: "PUT",
      path: "/clusters/{clusterId}/policy",
      summary: "Replace the cluster's engine knobs (owner only)",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId.extend(policyKnobsInput.shape))
    .output(clusterPolicyView),

  triggerCollect: oc
    .route({
      method: "POST",
      path: "/clusters/{clusterId}/collect",
      summary: "Queue a collect + classify for a cluster",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId)
    // Queued, not run: dialing a customer cluster can take a while, and doing
    // it on the request would stall an api process serving other tenants.
    .output(z.object({ queued: z.boolean() })),

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

  unhideRecommendation: oc
    .route({
      method: "POST",
      path: "/recommendations/{id}/unhide",
      summary: "Cancel a pending drop: make the index visible again now",
    })
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .input(z.object({ id: z.uuid() }))
    .output(recommendation),

  getOrg: oc
    .route({
      method: "GET",
      path: "/org",
      summary: "The caller's active org: members and pending invites",
    })
    .output(orgInfo),

  renameOrg: oc
    .route({ method: "PATCH", path: "/org", summary: "Rename the active org (owner only)" })
    .input(renameOrgInput)
    .output(z.object({ id: z.uuid(), name: z.string() })),

  setMemberRole: oc
    .route({
      method: "PATCH",
      path: "/org/members/{userId}",
      summary: "Change a member's role (owner only); the last owner cannot be demoted",
    })
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .input(z.object({ userId: z.string().min(1), role: memberRole }))
    .output(z.object({ userId: z.string(), role: z.string() })),

  removeMember: oc
    .route({
      method: "DELETE",
      path: "/org/members/{userId}",
      summary: "Remove a member from the active org (owner only; use leave for yourself)",
    })
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .input(z.object({ userId: z.string().min(1) }))
    .output(z.object({ removed: z.boolean() })),

  leaveOrg: oc
    .route({
      method: "POST",
      path: "/org/leave",
      summary: "Leave the active org; the last owner must transfer ownership first",
    })
    .errors({ CONFLICT: {} })
    .input(z.object({}))
    .output(z.object({ left: z.boolean() })),

  listOrgs: oc
    .route({
      method: "GET",
      path: "/orgs",
      summary: "Every org the caller belongs to, with the active one flagged",
    })
    .output(z.array(orgSummary)),

  switchOrg: oc
    .route({
      method: "POST",
      path: "/orgs/switch",
      summary: "Make another of the caller's orgs the active one",
    })
    .errors({ NOT_FOUND: {} })
    .input(z.object({ orgId: z.uuid() }))
    .output(orgSummary),

  createInvite: oc
    .route({
      method: "POST",
      path: "/org/invites",
      summary: "Invite someone into the org; returns the one-time token",
    })
    .input(createInviteInput)
    .output(createdInvite),

  acceptInvite: oc
    .route({ method: "POST", path: "/invites/accept", summary: "Join an org with an invite token" })
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .input(acceptInviteInput)
    .output(z.object({ orgId: z.uuid(), orgName: z.string() })),
};
