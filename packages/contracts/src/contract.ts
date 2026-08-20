import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import {
  checkConnectionInput,
  createClusterInput,
  observedDatabasesInput,
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
  clusterDatabases,
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
  securityTrail,
  supportedEngine,
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

  // What this build can connect, so the connect form can say so instead of
  // implying MongoDB with a placeholder. A property of the deployed code rather
  // than of the caller or their org — POSTGRESQL appears here the release its
  // adapter lands (#35) and not before, which is why the form asks rather than
  // carrying a sentence that would then be wrong.
  listSupportedEngines: oc
    .route({
      method: "GET",
      path: "/engines",
      summary: "Which database engines this build can connect, and the string forms each accepts",
    })
    .output(z.array(supportedEngine)),

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

  // The observe selection (#244). A GET that DIALS the cluster, which is unusual
  // enough here to say why: the whole point is to offer a database that appeared
  // after onboarding, and the only place that fact exists is the cluster itself.
  // Nothing collected can supply it — `SELECT DISTINCT database FROM
  // cluster_indexes` lists what has already been observed, so a database excluded
  // at connect time would never appear on the screen that exists to include it.
  //
  // Owner-only, like the routes that change what the engine may do: the list of
  // database names on a customer's cluster is not something a member needs to read
  // to use the dashboard.
  listClusterDatabases: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/databases",
      summary:
        "The cluster's user databases as it reports them now, and which of them are observed (owner only)",
    })
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {} })
    .input(clusterId)
    .output(clusterDatabases),

  // PUT rather than PATCH: the selection is replaced whole, the same way the
  // policy knobs are. A merge would have no way to express "stop observing this
  // one" that is not a second verb.
  setObservedDatabases: oc
    .route({
      method: "PUT",
      path: "/clusters/{clusterId}/databases",
      summary:
        "Replace which databases the collect walks (owner only); null observes every database the cluster has",
    })
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {} })
    .input(clusterId.extend(observedDatabasesInput.shape))
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
    // CONFLICT since #244: a proposal whose database has left the observe
    // selection is refused rather than moved into the pipeline. Changing the
    // selection already discards the open proposals outside it, so this is the
    // narrow race — an approve in flight while the selection changes — and it is
    // the one place a stale click could otherwise make the engine touch a database
    // the owner has said to leave alone.
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
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

  // Shorten a pending drop's observe window, never lengthen it. The window is
  // decided once at hide time and frozen on purpose — a date that walked as
  // history rolled out of retention would be useless to plan around — and this
  // is the deliberate exception, for the owner who knows the index is dead and
  // does not want to wait out a cadence the engine inferred.
  //
  // Not a general edit: the floor is the time already served, since a window
  // shortened into the past would drop on the very next finalize tick with no
  // notice, and the ceiling is the window already stamped, because lengthening
  // is what the policy baseline is for.
  shortenObserveWindow: oc
    .route({
      method: "POST",
      path: "/recommendations/{id}/observe-window",
      summary: "Shorten a pending drop's observe window (never lengthen it)",
    })
    .errors({ NOT_FOUND: {}, CONFLICT: {}, BAD_REQUEST: {} })
    // `days` omitted means the floor — end the observation, which is the only
    // thing the dashboard offers and the only one that needs no clock of its
    // own. Computing "how long has this been hidden" on the client would
    // duplicate the server's arithmetic and disagree with it across a day
    // boundary; asking for the floor by name cannot.
    .input(z.object({ id: z.uuid(), days: z.number().int().positive().optional() }))
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

  // The org's security trail (#158): sign-ins and failed sign-ins, every 2FA
  // event, role changes, invitations, and the four things that can be done to a
  // cluster's access. Written since #53 and read by nothing until now.
  //
  // OWNER-ONLY, and that is the load-bearing part of this route: it is
  // who-did-what, and every row carries a colleague's IP address and user agent.
  // A member reading everything in their org — the rule everywhere else — is the
  // wrong rule for this one.
  //
  // Scoped to the caller's active org, always. `security_events_actor_time`
  // exists for the other incident question, "everything this account did", which
  // crosses orgs — that is an operator's query and not a tenant's, so nothing
  // here can ask it.
  //
  // No plan window. Retention skips this table on purpose, so what a reader may
  // see is not an entitlement to sell; it is the whole trail back to the day it
  // shipped.
  listSecurityEvents: oc
    .route({
      method: "GET",
      path: "/security-events",
      summary:
        "The organization's security trail, newest first (owner only) — filterable by kind and by actor",
    })
    .input(
      z.object({
        // Both optional, and both exact: these are the two questions the table's
        // indexes were built for.
        event: z.string().optional(),
        actorUserId: z.string().optional(),
        // The cursor from the previous page. Both halves or neither — a time
        // without its tiebreak would skip a row that shares the microsecond.
        beforeCreatedAt: z.string().optional(),
        beforeId: z.uuid().optional(),
      }),
    )
    .output(securityTrail),

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
