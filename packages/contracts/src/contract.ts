import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import {
  checkConnectionInput,
  createClusterInput,
  policyKnobsInput,
  provisionClusterInput,
  renameClusterInput,
  rotateConnectionInput,
} from "./inputs.js";
import {
  auditAction,
  cluster,
  clusterCollections,
  clusterCooldowns,
  clusterEvent,
  clusterIndexSizeSeries,
  clusterLatency,
  clusterLatencySeries,
  clusterNodes,
  clusterPolicyView,
  clusterRecommendations,
  clusterRoi,
  connectionDiagnosis,
  myInvite,
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

  // Capped at the RECOMMENDATIONS_CAP highest-scoring, with the true total
  // beside them (#64). Nobody has asked to page through 20k proposals — they
  // want the top ones, which is what the default sort already gives — so the
  // cap carries an honest count rather than a cursor.
  listRecommendations: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/recommendations",
      summary: "The cluster's recommendations: the highest-scoring, and how many exist",
    })
    .input(clusterId)
    .output(clusterRecommendations),

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

  // Bucketed server-side, one point per day (#160). The rows behind it are
  // run-length encoded, so an unchanged index extends the row it has rather than
  // adding another — sending one point per run would be a payload that grows
  // with how much the cluster CHANGES, which is exactly the unbounded shape #64
  // bounded everywhere else.
  getIndexSizeSeries: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/index-size-series",
      summary:
        "Total index bytes per day over the trend window — is the footprint going down, net of what the application added",
    })
    .input(clusterId)
    .output(clusterIndexSizeSeries),

  getCollections: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/collections",
      summary: "Per-collection index footprint from the latest snapshot batch",
    })
    .input(clusterId)
    .output(clusterCollections),

  // Read on its own, never joined to `recommendations` (#159). A cooldown
  // OUTLIVES the recommendation that caused it: cancelling a pending drop parks
  // the index for 90 days and the row that was cancelled can be pruned or
  // rewritten by the next classify pass long before that. A join would quietly
  // drop exactly the cooldowns that have been in force the longest.
  listCooldowns: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/cooldowns",
      summary:
        "Indexes the engine has agreed not to propose again, why, how many times each has regressed, and until when",
    })
    .input(clusterId)
    .output(clusterCooldowns),

  getNodes: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/nodes",
      summary:
        "The node roster from the last collect: every member the cluster admitted to, its role, and whether it answered",
    })
    .input(clusterId)
    .output(clusterNodes),

  listActions: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/actions",
      summary: "The cluster's audit trail (latest 50 executed operations)",
    })
    .input(clusterId)
    .output(z.array(auditAction)),

  // GET on purpose, twice over: an event stream reads and changes nothing, and
  // SSE is what OpenAPILink speaks for an eventIterator over GET — the browser
  // subscribes with the session cookie it already holds, no relay in between
  // (decisions D31). NOT_FOUND rather than an empty stream for a cluster the
  // caller does not own: an empty stream never ends, and a reader hanging on a
  // cluster that will never speak is worse than being told it is not theirs.
  listClusterEvents: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/events",
      summary:
        "Live cluster events (SSE): a worker pass landed, a drop went hidden, a build graduated, a regression fired",
    })
    .errors({ NOT_FOUND: {} })
    .input(clusterId)
    .output(eventIterator(clusterEvent)),

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

  // PATCH on the cluster itself, not on a sub-path: the name IS the cluster's
  // own attribute, unlike its connection or its mode. Owner-only, like both of
  // those, and BAD_REQUEST for a name another cluster in the org already has —
  // the rail and every alert subject line are the reason it has to be unique.
  renameCluster: oc
    .route({
      method: "PATCH",
      path: "/clusters/{clusterId}",
      summary:
        "Rename a cluster (owner only) — the name in the rail, the header and every alert subject; unique within the org",
    })
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {} })
    .input(clusterId.extend(renameClusterInput.shape))
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

  // The two org reads the dashboard needs and better-auth's organization plugin
  // does not answer.
  //
  // Everything that CHANGES an org — create, rename, delete, invite, accept,
  // role, remove, leave, switch — moved onto the plugin's own endpoints under
  // /api/auth/organization/*, and the seven routes that used to be here went
  // with it. These two stayed because neither is about membership: one carries
  // the plan and what it has left, which is ours and not a plugin concept, and
  // the other carries the caller's role per org, which `organization.list` does
  // not return.
  getOrg: oc
    .route({
      method: "GET",
      path: "/org",
      summary:
        "The caller's active org: plan, usage, members, pending invites — null when they are in none",
    })
    .output(orgInfo.nullable()),

  listOrgs: oc
    .route({
      method: "GET",
      path: "/orgs",
      summary: "Every org the caller belongs to, with the active one flagged",
    })
    .output(z.array(orgSummary)),

  // Answered outside any org on purpose: someone in no organization at all is
  // exactly who needs to see they have been invited to one.
  //
  // The plugin has `list-user-invitations`, and it returns everything this does
  // including the org's name. It is not used because it refuses outright unless
  // `user.emailVerified` — unconditionally, not gated on the plugin's own
  // `requireEmailVerificationOnInvitation`, which we set from the deployment's
  // posture. On an install that does not require verification (dev, the e2e
  // suite, a self-hosted instance behind SSO) every reader would get a 403 on
  // page load for a list that is not a secret: the invitations are addressed to
  // them, and accepting one still goes through the plugin, where that
  // verification rule belongs and is applied.
  listMyInvites: oc
    .route({
      method: "GET",
      path: "/invites",
      summary: "Pending invitations addressed to the caller, from any org",
    })
    .output(z.array(myInvite)),
};
