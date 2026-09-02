import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import {
  checkConnectionInput,
  clusterTunnelInput,
  createClusterInput,
  createTunnelInput,
  observedDatabasesInput,
  orgPolicyInput,
  policyKnobsInput,
  provisionClusterInput,
  renameClusterInput,
  rotateConnectionInput,
  updateTunnelInput,
} from "./inputs.js";
import {
  auditAction,
  CLUSTER_INDEXES_PAGE_MAX,
  cluster,
  clusterCollections,
  clusterCooldowns,
  clusterDatabases,
  clusterEvent,
  clusterIndexes,
  clusterIndexSizeSeries,
  clusterLatency,
  clusterLatencySeries,
  clusterNodes,
  clusterPolicyView,
  clusterPrivileges,
  clusterRecommendations,
  clusterRoi,
  clusterWorkload,
  connectionDiagnosis,
  indexSortKey,
  myInvite,
  offboardResult,
  orgInfo,
  orgPolicyView,
  orgSummary,
  provisionedCluster,
  recommendation,
  securityTrail,
  sortDirection,
  supportedEngine,
  tunnelTestResult,
  tunnelView,
  WORKLOAD_SHAPES_PAGE_MAX,
  workloadSortKey,
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

  // Every index the cluster HAS, not only the ones something is proposing about
  // (#431). `getCollections` above sums the same snapshots to a count and a byte
  // total per collection — a collection with fourteen indexes is one row saying
  // fourteen — and index-level numbers reached the dashboard only as
  // `IndexUsage`, which is keyed by `recommendationId` (D66). So the only
  // indexes a customer could see were the ones we already wanted to change.
  //
  // Paged by OFFSET rather than capped like `listRecommendations`, because the
  // question is different: proposals are RANKED, so the top few are the answer
  // and paging buys nothing, while an inventory is browsed — "what else is on
  // `orders`" has no top. Namespace order for the same reason, and the two
  // optional filters are that order's own scoping.
  //
  // It was a keyset cursor until #445, and offset is a deliberate trade rather
  // than a simplification (D133). Keyset can only step, so the reader got a Back
  // and a More button and no way to reach page five of six; browsing is exactly
  // the access pattern that wants a page number. What offset gives up is the
  // guarantee keyset had for free: the set moves under the reader — a collect
  // lands, an index is built — and a page boundary can then repeat or skip the
  // row that crossed it. Survivable HERE, and only here, because a namespace is
  // not a queue: nothing is consumed by being read, `total` is re-counted per
  // request so the page count follows the set, and the collect cadence is hours
  // against a reader who pages in seconds. The security trail keeps its cursor
  // (D67) and so does the workload list beside this one, which is ranked.
  getClusterIndexes: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/indexes",
      summary:
        "One page of the cluster's index inventory: spec, flags, size and per-member usage for every index the last collect saw",
    })
    .input(
      z.object({
        clusterId: z.uuid(),
        // Exact, both of them, and `collection` without `database` is accepted:
        // two databases holding a collection of the same name is normal, and
        // refusing the narrower ask would only send the reader to page through
        // the wider one.
        database: z.string().optional(),
        collection: z.string().optional(),
        // Where the page starts, in rows. Coerced because this arrives as a query
        // string; clamped rather than refused past the end, since a reader who
        // filters while on page five has asked for an offset that no longer exists
        // and an empty page would read as "this cluster has no indexes".
        offset: z.coerce.number().int().nonnegative().optional(),
        // How many rows the page carries. Bounded at both ends: the floor stops a
        // request for zero rows paging forever, and the ceiling is what keeps this
        // endpoint a page rather than a report — the reason it pages at all is that
        // an index list is unbounded.
        limit: z.coerce.number().int().min(1).max(CLUSTER_INDEXES_PAGE_MAX).optional(),
        // The order and the filter live HERE and not in the dashboard, because the
        // server decides which rows the page holds (D135). A control that orders the
        // hundred rows in front of the reader while the server chose WHICH hundred is
        // not sorting the cluster: "size descending" then means "the biggest of an
        // arbitrary hundred", which is the one reading nobody wants and the one it
        // looked like it was doing.
        sort: indexSortKey.optional(),
        dir: sortDirection.optional(),
        // Substring, case-insensitive, over `database.collection` and the index name.
        // Narrower than the client filter it replaces, which matched any rendered
        // cell — the flags and the key pattern are computed after the read, so they
        // cannot be a SQL predicate. Narrower in scope and wider in REACH: it
        // searches the cluster now rather than the page.
        q: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .output(clusterIndexes),

  // The queries that MISS an index, including the ones the engine declined to
  // act on (#432).
  //
  // `collector.collectWorkload` has always returned every scanning shape with
  // its executions, its documents walked and the window behind both.
  // `jobs/suggest.ts` read them once an hour, used them in memory, and persisted
  // only the recommendations that cleared every create-side gate — so a query
  // walking 900k documents a week on a small collection was seen, priced,
  // discarded, and never mentioned. Every gate is right; each worked by making
  // the FINDING disappear along with the proposal, which is the same defect #277
  // fixed on the drop side.
  //
  // Ranked by weekly cost rather than sorted by namespace, which is the
  // difference from `getClusterIndexes` beside it: an inventory is browsed, and
  // this is a list of problems, so the worst ones are the answer.
  //
  // Paged by offset since #445, the same as the inventory (D133). The ranking is
  // what makes it sound rather than merely convenient: the sort key is
  // `(weekly cost desc, id)` and the id is not decoration — two shapes on one
  // collection sharing a weekly figure is ordinary, so without it the order is
  // PARTIAL, and under offset a partial order lets one row appear on two pages of
  // a single browse where a keyset cursor merely stalled.
  getClusterWorkload: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/workload",
      summary:
        "One page of the cluster's scanning query shapes: what an index would have to cover, what the scanning costs, and which gate declined to act on it",
    })
    .input(
      z.object({
        clusterId: z.uuid(),
        database: z.string().optional(),
        collection: z.string().optional(),
        // Only the shapes nothing was proposed for, which is the question the
        // page exists to answer and the one no other screen can.
        declinedOnly: z.coerce.boolean().optional(),
        // Where the page starts and how big it is. Coerced from the query string,
        // and the limit is bounded at both ends for the reason the inventory gives:
        // a floor so a request for zero rows cannot page forever, and a ceiling
        // that keeps this a page rather than a report.
        offset: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(WORKLOAD_SHAPES_PAGE_MAX).optional(),
        // Same reasoning as the inventory above (D135). The default stays weekly cost
        // descending, which is the ranking this list exists to present.
        sort: workloadSortKey.optional(),
        dir: sortDirection.optional(),
        q: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .output(clusterWorkload),

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
    // LEAST_PRIVILEGE is #313's refusal: this org has said it will not hold
    // credentials that can create users, and these can. 422 rather than 400 — the
    // request is well formed and the string works, and what is wrong with it is a
    // policy this org set rather than a mistake in what was typed.
    .errors({ BAD_REQUEST: {}, LEAST_PRIVILEGE: { status: 422 } })
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
    // Refused on the same rule as connecting, because rotation is the other door
    // and the only one an already-connected cluster has (#313).
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {}, LEAST_PRIVILEGE: { status: 422 } })
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

  // What the STORED credentials hold, re-checked now (#313).
  //
  // A GET that dials the customer's cluster, like listClusterDatabases above and
  // for a related reason: the only place the answer exists is the cluster itself,
  // and nothing we have collected can supply it — a snapshot records indexes, not
  // grants. `credentialPosture` on the cluster row is the closest thing, and it is
  // one enum stamped at connect time.
  //
  // Owner-only, and this one is not a judgement call: the response enumerates what
  // a credential on somebody's production database is permitted to do, which is
  // half of what an attacker would want to know before using it.
  //
  // Not prefetched by the settings route's loader, unlike the database list beside
  // it. Both dial, and this one has no second purpose — the reader opens the card
  // and asks. Costing every settings page view a round trip to a production
  // cluster for a panel most visits never expand is the trade the observe list
  // already makes once; making it twice is how a settings page becomes slow.
  getClusterPrivileges: oc
    .route({
      method: "GET",
      path: "/clusters/{clusterId}/privileges",
      summary:
        "Re-check the stored credentials against the cluster (owner only): what the engine needs, and what they hold and never use",
    })
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {} })
    .input(clusterId)
    .output(clusterPrivileges),

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

  // The org's own policy, read by anyone in it and written by owners (#313).
  //
  // Split from `getOrg` for the write, not for the read — the read is folded into
  // the org payload, because the connection card of every cluster needs it and a
  // per-card fetch of one boolean is worse than a field. This pair exists so the
  // write has a route, and the GET exists beside it so a client that only cares
  // about the policy is not made to fetch the member list to see it.
  getOrgPolicy: oc
    .route({
      method: "GET",
      path: "/org/policy",
      summary: "The org's policy: whether credentials broader than the engine needs are refused",
    })
    .output(orgPolicyView),

  updateOrgPolicy: oc
    .route({
      method: "PUT",
      path: "/org/policy",
      summary: "Replace the org's policy (owner only)",
    })
    .input(orgPolicyInput)
    .output(orgPolicyView),

  // Tunnels (#353). Org-scoped rather than cluster-scoped, because one peering
  // commonly reaches several clusters on the same network and duplicating the
  // config per cluster would mean rotating a key in N places.
  listTunnels: oc
    .route({
      method: "GET",
      path: "/tunnels",
      summary: "The org's WireGuard tunnels, and whether this deployment can use them at all",
    })
    // An object rather than the bare array it was, so the answer can carry
    // `enabled`. A deployment with no tunnel service configured is a SUPPORTED
    // state — the feature is off — and the dashboard has to be able to say so
    // instead of drawing a form whose every submission fails at the last step.
    //
    // The rows come back either way. A peering registered before the operator
    // removed the setting still exists, and hiding it would leave an owner unable
    // to see or remove what their org is carrying.
    .output(
      z.object({
        enabled: z.boolean(),
        tunnels: z.array(tunnelView),
      }),
    ),

  createTunnel: oc
    .route({
      method: "POST",
      path: "/tunnels",
      summary: "Register a WireGuard peering from a pasted wg0.conf (owner only)",
    })
    // BAD_REQUEST carries the parser's own sentence — which directive was wrong
    // and why — because "invalid config" is useless to somebody holding a file
    // they did not write.
    .errors({ BAD_REQUEST: {}, CONFLICT: {} })
    .input(createTunnelInput)
    .output(tunnelView),

  updateTunnel: oc
    .route({
      method: "PATCH",
      path: "/tunnels/{tunnelId}",
      summary: "Rename a tunnel, or replace its wg0.conf after a key rotation (owner only)",
    })
    // A config replaced here goes through the same parser a registration does,
    // so the same directive-naming sentence comes back. CONFLICT is the org's
    // unique name, exactly as on create.
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {}, CONFLICT: {} })
    .input(
      z
        .object({ tunnelId: z.uuid() })
        .extend(updateTunnelInput.shape)
        // A PATCH with neither field is a bug in the caller, not an owner
        // clearing something: there is nothing on a tunnel that can be unset.
        .refine((input) => input.name !== undefined || input.config !== undefined, {
          message: "Change the name, the config, or both",
        }),
    )
    .output(tunnelView),

  testTunnel: oc
    .route({
      method: "POST",
      path: "/tunnels/{tunnelId}/test",
      summary: "Bring the tunnel up and wait for a handshake, to prove the gateway answers",
    })
    // A tunnel that will not come up is a 200 with reachable:false, not an
    // error: "the gateway did not answer" is the ANSWER to this request, and an
    // error status would make the dashboard draw it as a failed request.
    // BAD_REQUEST is kept for the config being unreadable, where there is
    // nothing to test.
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {} })
    .input(z.object({ tunnelId: z.uuid() }))
    .output(tunnelTestResult),

  deleteTunnel: oc
    .route({
      method: "DELETE",
      path: "/tunnels/{tunnelId}",
      summary: "Remove a tunnel; refused while any cluster is still reached through it",
    })
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .input(z.object({ tunnelId: z.uuid() }))
    .output(z.object({ deleted: z.literal(true) })),

  setClusterTunnel: oc
    .route({
      method: "PUT",
      path: "/clusters/{clusterId}/tunnel",
      summary: "Choose which tunnel reaches this cluster, or null to dial it directly (owner only)",
    })
    .errors({ NOT_FOUND: {}, BAD_REQUEST: {} })
    .input(clusterId.extend(clusterTunnelInput.shape))
    .output(cluster),

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
