import { z } from "zod";

export const recommendationType = z.enum([
  "DROP_UNUSED",
  "DROP_REDUNDANT",
  "MERGE",
  "CREATE",
  "UPDATE",
  // Rebuild a PROTECTED index with the same keys in the same order and
  // different DIRECTIONS. Its own type rather than an UPDATE because UPDATE
  // means "extend to a wider key set", and a reader approving a change to a
  // unique index is owed wording that says the constraint is preserved.
  "REORDER",
  "ADVISORY_REVIEW",
]);
export type RecommendationType = z.infer<typeof recommendationType>;

export const usageClass = z.enum(["CONTINUOUS", "PERIODIC_ALIVE", "PERIODIC_DEAD", "FLAT_ZERO"]);
export type UsageClass = z.infer<typeof usageClass>;

// Full lifecycle across drop and create pipelines (the wiki's Architecture
// page, Apply pipeline).
export const recommendationState = z.enum([
  "PROPOSED",
  "APPROVED",
  "HIDDEN",
  "OBSERVE",
  "DROPPED",
  "SCHEDULED",
  "BUILDING",
  "ACTIVE",
  "ROLLED_BACK",
  "REJECTED",
]);
export type RecommendationState = z.infer<typeof recommendationState>;

export const connectionMode = z.enum(["HOSTED_DIRECT", "AGENT"]);
export type ConnectionMode = z.infer<typeof connectionMode>;

// The database engine behind a cluster. MONGODB and MSSQL both connect today;
// POSTGRESQL is the enum's forward-compatible slot, and the api refuses it with
// that word rather than pretending it does not exist (#35, and the wiki's
// Architecture page under Engine ports). Which of the three a BUILD actually
// carries is `supportedEngines` below rather than this list — the enum is the
// vocabulary, the endpoint is the inventory.
export const clusterEngine = z.enum(["MONGODB", "POSTGRESQL", "MSSQL"]);
export type ClusterEngine = z.infer<typeof clusterEngine>;

// One engine this build can actually connect, with the forms of string it takes.
//
// The hint is the adapter's own — the same sentence its refusal quotes — so the
// connect form's helper text and the error a bad string produces cannot describe
// different products. Read by the dashboard to say what is accepted and to fill
// the engine override; nothing tenant-specific, so it is the same answer for
// every caller of a given build.
export const supportedEngine = z.object({
  engine: clusterEngine,
  connStringHint: z.string(),
});
export type SupportedEngine = z.infer<typeof supportedEngine>;

// The three MongoDB options that keep TLS switched on while turning off the part
// that makes it worth having. Each is a checkbox on the connect form, because a
// connection nobody validates the certificate of is a connection anyone in the
// path can be — that is a decision an owner should make on purpose, not one that
// rides in on a pasted string nobody read to the end of.
//
// Named one per driver option rather than collapsed into a single "insecure"
// toggle: they are not the same concession. A private CA fails certificate
// validation while the hostname is perfectly correct, and an SSH tunnel or a
// rewritten DNS name fails the hostname check with a certificate that is
// genuinely valid. Offering one switch would make everyone give up both.
export const tlsOverrides = z.object({
  // Connect even if the server's certificate does not verify — self-signed, or
  // signed by a CA we do not carry.
  allowInvalidCertificates: z.boolean(),
  // Connect even if the certificate is for a different name than the one dialed.
  allowInvalidHostnames: z.boolean(),
  // The driver's tlsInsecure: the broadest of the three. Disables certificate
  // AND hostname checking, and on top of that accepts expired certificates and
  // skips revocation.
  insecure: z.boolean(),
});
export type TlsOverrides = z.infer<typeof tlsOverrides>;

export const NO_TLS_OVERRIDES: TlsOverrides = {
  allowInvalidCertificates: false,
  allowInvalidHostnames: false,
  insecure: false,
};

export const cluster = z.object({
  id: z.uuid(),
  name: z.string(),
  connectionMode,
  engine: clusterEngine,
  readOnly: z.boolean(),
  // Which WireGuard tunnel reaches this cluster, null when it is dialled
  // directly (#353). Orthogonal to connectionMode rather than a value in it:
  // "over a tunnel" and "via a relay agent" are not mutually exclusive.
  tunnelId: z.uuid().nullable(),
  // Set when Indexterity provisioned its own least-privilege user on the
  // cluster (admin-string onboarding); null for pasted-string clusters.
  provisionedUsername: z.string().nullable(),
  // What removes that user, in the engine's own language, null alongside the
  // username above. Sent with the cluster rather than composed in the dashboard
  // (#338): the disconnect dialog shows it BEFORE the call that would return it,
  // and the version it used to compose there was MongoDB's on every engine.
  //
  // May be several statements separated by newlines — PostgreSQL and SQL Server
  // both have to visit each provisioned database before dropping the principal —
  // so it is rendered pre-formatted, not inline.
  revokeCommand: z.string().nullable(),
  // What the stored credentials COULD do, as against what `readOnly` allows
  // them to. Recorded when they were stored and re-evaluated on rotation.
  //
  // Null means we never asked — every cluster connected before the column
  // existed, and any rotation whose diagnosis failed. Rendered as "not
  // recorded" rather than as a guess, for the same reason a failed read is not
  // an empty state (#289).
  credentialPosture: z.enum(["PROVISIONED", "ADMIN", "SCOPED"]).nullable(),
  // Newest index snapshot, or null before the first collect. The dashboard
  // flags stale data so numbers from before an outage cannot read as current.
  lastCollectedAt: z.string().nullable(),
  // Which TLS checks this cluster was connected with turned off. Read back, not
  // just written: a security concession the owner cannot see afterwards is one
  // nobody reviews.
  tlsOverrides,
  // Which databases the collect walks, or null for every one the cluster has
  // (#244). Read back for the same reason as the line above: a cluster observed
  // in part looks exactly like one observed whole from every panel that reads it,
  // and "why is there nothing for staging" has to be answerable from the screen
  // rather than from the connect form six months ago.
  observedDatabases: z.array(z.string()).nullable(),
  createdAt: z.string(),
});
export type Cluster = z.infer<typeof cluster>;

// One privilege the engine needs and whether the credentials have it.
// CORE = analysis impossible without it; APPLY = analysis-only without it;
// WORKLOAD = an optional signal source.
// CORE/APPLY/WORKLOAD are what the ENGINE needs. PROVISION is a different
// question — whether these credentials could create the scoped user for us — and
// is reported as checks rather than only as the `canProvision` boolean below, so
// a refused offer can name the action that would unlock it (#86).
//
// SURPLUS is the same list read backwards (#313): a grant these credentials HOLD
// that the engine never uses. `granted: true` on one of those is the finding, not
// the reassurance — which is why they arrive in their own array rather than mixed
// into `privileges`, where every existing consumer reads a tick as good news and
// `ready`/`canApply`/`missing` are all derived from "is every check granted".
export const privilegeTier = z.enum(["CORE", "APPLY", "WORKLOAD", "PROVISION", "SURPLUS"]);
export type PrivilegeTier = z.infer<typeof privilegeTier>;

export const privilegeCheck = z.object({
  key: z.string(),
  label: z.string(),
  enables: z.string(),
  tier: privilegeTier,
  granted: z.boolean(),
  // The statements that would close this gap, ready to run, or null when there is
  // nothing to hand over (#246).
  //
  // Engine-neutral field, engine-specific content: SQL Server's Query Store check
  // fills it with one ALTER DATABASE per database that is missing it, and the mongo
  // checks carry null until somebody wants `db.grantRolesToUser(…)` here too. The
  // alternative was a Query-Store-shaped field on the diagnosis, which would put one
  // engine's configuration vocabulary in the shared contract.
  //
  // Only ever set on a check that is NOT granted — except on a SURPLUS check,
  // where the whole polarity is reversed: there `granted: true` is the finding and
  // the command is what REVOKES the grant rather than what adds it (#313). The
  // direction is unambiguous from which array the check arrived in, which is why
  // segregating them was worth more than a second field would have been.
  //
  // `.default(null)` so a caller parsing a response from an api that predates the
  // field gets null rather than a validation error or an undefined that reaches a
  // `.split`. The api always sends it; the tolerance is for the window where one
  // side of a deploy has moved and the other has not.
  command: z.string().nullable().default(null),
});
export type PrivilegeCheck = z.infer<typeof privilegeCheck>;

// What a pasted connection string can actually do — computed before anything
// is stored, so onboarding can name what is missing or offer to provision.
export const connectionDiagnosis = z.object({
  // Which engine answered — the api's own verdict, not the browser's guess. The
  // form draws a scheme-level hint while the reader types (engine-hint.ts) and
  // replaces it with this the moment a diagnosis lands, because this one is the
  // engine that will be stored if they press Connect.
  engine: clusterEngine,
  reachable: z.boolean(),
  message: z.string().nullable(),
  username: z.string().nullable(),
  authEnabled: z.boolean(),
  canProvision: z.boolean(),
  ready: z.boolean(),
  canApply: z.boolean(),
  privileges: z.array(privilegeCheck),
  // What these credentials hold and the engine never uses (#313). Every entry is
  // tier SURPLUS, so `granted: true` means "held, and removable" — the reverse of
  // every other check here — and `command` carries the statement that removes it.
  //
  // Its own array and not part of `privileges` above for two reasons that both
  // bite: `ready`, `canApply` and `missing` are computed from "is every check in
  // its tier granted", which a held surplus grant would satisfy and a revoked one
  // would break; and the connect form's PrivilegeList draws any non-PROVISION
  // check as something the engine needs, so `root` would render as a requirement.
  //
  // Empty is a real answer and the reassuring one — a provisioned user holds
  // nothing surplus by construction — so the screen that draws it has to SAY
  // empty rather than draw nothing (#289, and #313's second constraint).
  //
  // `.default([])` for the deploy window where the web has moved and the api has
  // not, the same tolerance `command` above carries.
  surplus: z.array(privilegeCheck).default([]),
  missing: z.array(z.string()),
  // Every user database the credentials can see, which both engines' probes
  // already had to enumerate to answer the questions above — mongo evaluates its
  // anyDb requirements against this list, and MSSQL asks each database for its
  // own grants. It used to be discarded; the connect form needs it to offer the
  // observe checkboxes before anything is stored (#244).
  //
  // Empty is a real answer rather than a missing one: credentials that cannot run
  // listDatabases get an empty list and a `listDatabases` privilege gap beside
  // it, and the form draws the gap instead of an empty checkbox list.
  databases: z.array(z.string()),
});
export type ConnectionDiagnosis = z.infer<typeof connectionDiagnosis>;

// The stored credentials re-checked against the cluster, for the connection card
// (#313).
//
// A separate route and a separate shape from `connectionDiagnosis` because it
// answers a different question about a different string. The diagnosis is a
// preflight on something the reader just pasted and nothing holds yet; this is a
// dial with the sealed credentials a cluster has been running on for months, and
// the reader's question about those is not "will this connect" but "what is this
// allowed to do that it does not need".
//
// `checkedAt` is on the payload rather than left to the cache, and it is the
// whole answer to the issue's first constraint: nothing else re-checks an
// existing cluster, so without a timestamp these numbers are indistinguishable
// from the ones taken at connect time — which may be a year old and taken on
// credentials that have since been rotated.
export const clusterPrivileges = z.object({
  clusterId: z.uuid(),
  engine: clusterEngine,
  // When the dial below happened. Always now for a fresh read; carried so the
  // card can label the figures rather than implying they are live.
  checkedAt: z.string(),
  // False when the cluster could not be dialled at all, with `message` saying
  // why. Not an error response: a cluster that is down still has a connection
  // card, and that card is where its credentials are rotated.
  reachable: z.boolean(),
  message: z.string().nullable(),
  // Who the stored string authenticates as, which is the one fact on this card a
  // reader can take to their own database and act on.
  username: z.string().nullable(),
  authEnabled: z.boolean(),
  // The engine's own requirements — CORE, APPLY and WORKLOAD — as they stand
  // against the stored credentials. PROVISION checks are deliberately absent:
  // whether the string could create a user is what `credentialPosture` on the
  // cluster already says, and re-listing the three actions behind it here would
  // put "cannot create users" on a card whose subject is what the credentials do
  // hold.
  required: z.array(privilegeCheck),
  // Held and never used, each with the statement that removes it.
  surplus: z.array(privilegeCheck),
});
export type ClusterPrivileges = z.infer<typeof clusterPrivileges>;

// The observe selection, as the settings screen needs it: what the cluster has
// RIGHT NOW beside what we are walking (#244).
//
// Both halves in one read on purpose. The stored selection alone cannot draw the
// screen — a database added since onboarding has to be offerable, and one that has
// since been dropped must not be drawn as a live choice — and the live list alone
// cannot say which boxes are ticked. Two reads would let a collect land between
// them and produce a screen that never described the cluster.
//
// `available` is the cluster's answer, not the intersection: a stored name that is
// no longer there is simply absent from it, which is how the screen reports a
// dropped database without the api having to prune the selection behind the
// owner's back.
export const clusterDatabases = z.object({
  available: z.array(z.string()),
  observed: z.array(z.string()).nullable(),
});
export type ClusterDatabases = z.infer<typeof clusterDatabases>;

// Returned once at provisioning — the scoped connection string is also stored
// sealed, but the admin string it was derived from is never persisted.
export const provisionedCluster = z.object({
  cluster,
  username: z.string(),
  connectionString: z.string(),
});
export type ProvisionedCluster = z.infer<typeof provisionedCluster>;

export const recommendation = z.object({
  id: z.uuid(),
  clusterId: z.uuid(),
  type: recommendationType,
  usageClass: usageClass.nullable(),
  state: recommendationState,
  database: z.string(),
  collection: z.string(),
  indexName: z.string(),
  rationale: z.string(),
  // Confidence 0-100 — gates propose/auto-approve, never the safety stages.
  score: z.number().int().min(0).max(100),
  estimatedBytesSaved: z.number().int().nonnegative(),
  // When the index was hidden, and the observe window this particular drop was
  // given — decided from the index's own usage pattern, not the policy default
  // (a monthly report waits out a full cycle; one still serving traffic answers
  // within days). Both null until the drop reaches HIDDEN.
  //
  // Exposed because the score cannot answer the question anyone actually has
  // in front of a hidden index: when does this get dropped? "82" does not say.
  // A date does.
  hiddenAt: z.string().nullable(),
  observeDays: z.number().int().positive().nullable(),
  // And why that window, when it differs from the policy baseline. The number
  // alone reads as arbitrary next to another row with a different one; this is
  // the sentence the engine already wrote to explain it.
  observeReason: z.string().nullable(),
  createdAt: z.string(),
});
export type Recommendation = z.infer<typeof recommendation>;

// One dropped index's net contribution to the ROI headline (undo rows netted
// out; only positive contributors are listed).
export const roiContribution = z.object({
  recommendationId: z.uuid(),
  database: z.string(),
  collection: z.string(),
  indexName: z.string(),
  freedBytes: z.number().int().positive(),
  estimatedMonthlyUsd: z.number().nonnegative(),
});
export type RoiContribution = z.infer<typeof roiContribution>;

export const clusterRoi = z.object({
  clusterId: z.uuid(),
  freedBytes: z.number().int().nonnegative(),
  indexesDropped: z.number().int().nonnegative(),
  estimatedMonthlyUsd: z.number().nonnegative(),
  attribution: z.array(roiContribution),
});
export type ClusterRoi = z.infer<typeof clusterRoi>;

// Per-collection index footprint from the latest snapshot batch.
export const collectionStat = z.object({
  database: z.string(),
  collection: z.string(),
  indexCount: z.int().nonnegative(),
  totalIndexBytes: z.int().nonnegative(),
  proposedRecommendations: z.int().nonnegative(),
});
export type CollectionStat = z.infer<typeof collectionStat>;

export const clusterCollections = z.object({
  clusterId: z.uuid(),
  collections: z.array(collectionStat),
});
export type ClusterCollections = z.infer<typeof clusterCollections>;

// One node of the cluster as the last collect saw it (#100). `refused` is this
// deployment's net guard declining to dial the address the cluster named — a
// policy fact, not member health — and a role stays "unknown" exactly when the
// node never answered the handshake that would have named one.
export const clusterNode = z.object({
  host: z.string(),
  role: z.enum(["primary", "secondary", "mongos", "standalone", "unknown"]),
  state: z.enum(["answered", "unreachable", "refused"]),
});
export type ClusterNodeView = z.infer<typeof clusterNode>;

// collectedAt is null only when no collect has ever landed a roster — the
// panel's "nothing collected yet" state. A stale roster keeps its own stamp,
// which is what makes "as of six hours ago" sayable.
export const clusterNodes = z.object({
  clusterId: z.uuid(),
  collectedAt: z.string().nullable(),
  nodes: z.array(clusterNode),
});
export type ClusterNodes = z.infer<typeof clusterNodes>;

// One index the engine has agreed not to touch, and until when (#159).
//
// Written from three places — the regression gate when reads got worse after a
// drop was hidden, the post-build watch when writes got worse, and an owner
// cancelling or undoing a drop. `reason` is the writer's own sentence, so the
// panel does not have to keep a translation table of engine decisions in sync
// with the engine.
//
// `regressionCount` is the field with no other home anywhere in the product: an
// index that has regressed three times is saying something about the collection
// that a single rejection does not. Zero on the two owner paths, deliberately —
// nothing regressed there, somebody simply knows something the engine does not,
// and counting it would feed the escalating backoff a fact that never happened.
export const parkedIndex = z.object({
  database: z.string(),
  collection: z.string(),
  indexName: z.string(),
  reason: z.string(),
  regressionCount: z.int().nonnegative(),
  until: z.string(),
  // Whether `until` is still in the future. Computed by the api against ITS
  // clock, not left to the browser's: a laptop an hour behind would draw a
  // parked index as eligible, and this is the field the panel's headline counts.
  active: z.boolean(),
  // The COLLECTION is parked rather than one of its indexes (#282): several
  // builds each passed their own post-build check and together slowed its
  // writes, so nothing was rolled back and nothing more is built on it
  // unattended. `indexName` is empty on these rows — the storage sentinel —
  // and this is the flag, so the sentinel does not have to be understood twice.
  wholeCollection: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ParkedIndex = z.infer<typeof parkedIndex>;

// Every index this cluster has ever parked, active ones first.
//
// Uncapped, like getCollections and unlike the two reads #64 bounded. The bound
// is structural rather than measured: the table is unique on (cluster, database,
// collection, index), so it holds at most one row per index — and only per index
// that a regression or an owner has actually parked, which is a rare event by
// construction rather than something a collect writes on a schedule.
export const clusterCooldowns = z.object({
  clusterId: z.uuid(),
  // Of the rows below, how many are still parked. The panel leads with this and
  // the list carries the expired ones underneath, so `parked.length` is never
  // the headline number.
  activeCount: z.int().nonnegative(),
  // The soonest `until` still in the future — "next eligible" — or null when
  // nothing is parked.
  nextEligibleAt: z.string().nullable(),
  parked: z.array(parkedIndex),
});
export type ClusterCooldowns = z.infer<typeof clusterCooldowns>;

// The result of disconnecting a cluster: how many in-flight hidden indexes were
// restored, and the command to revoke the provisioned user (null when the
// cluster was connected with a pasted string).
export const offboardResult = z.object({
  unhidden: z.int().nonnegative(),
  revokeCommand: z.string().nullable(),
});
export type OffboardResult = z.infer<typeof offboardResult>;

// One org the caller belongs to — the switcher's option list. `active` is per
// SESSION, not per user: two browsers can sit in two different orgs.
export const orgSummary = z.object({
  orgId: z.uuid(),
  name: z.string(),
  role: z.string(),
  active: z.boolean(),
});
export type OrgSummary = z.infer<typeof orgSummary>;

// Per-collection read/write latency: current vs baseline windowed average (µs/op)
// and the percent change. Negative delta = faster. Nulls when data is too sparse.
export const latencySummary = z.object({
  database: z.string(),
  collection: z.string(),
  samples: z.number().int(),
  currentReadMicros: z.number().nullable(),
  baselineReadMicros: z.number().nullable(),
  readDeltaPct: z.number().nullable(),
  currentWriteMicros: z.number().nullable(),
  baselineWriteMicros: z.number().nullable(),
  writeDeltaPct: z.number().nullable(),
});
export type LatencySummary = z.infer<typeof latencySummary>;

export const clusterLatency = z.object({
  clusterId: z.uuid(),
  collections: z.array(latencySummary),
});
export type ClusterLatency = z.infer<typeof clusterLatency>;

// One windowed µs/op point per collect interval — the chart series.
export const latencySeriesPoint = z.object({
  capturedAt: z.string(),
  readMicros: z.number().nullable(),
  writeMicros: z.number().nullable(),
});
export type LatencySeriesPoint = z.infer<typeof latencySeriesPoint>;

// Why a metric has no drawable point, when it has none — null when it has one.
// Shipped so the panel can say WHICH kind of nothing this is: waiting on a
// second collect, a counter that never moved, or a mongod restart that made the
// window unmeasurable. Without it every one of them renders as the same
// "not enough samples", which is how #85 came in twice.
export const latencyGap = z.enum(["AWAITING_SECOND_COLLECT", "NO_OPS_RECORDED", "COUNTERS_RESET"]);
export type LatencyGap = z.infer<typeof latencyGap>;

export const collectionLatencySeries = z.object({
  database: z.string(),
  collection: z.string(),
  points: z.array(latencySeriesPoint),
  readGap: latencyGap.nullable(),
  writeGap: latencyGap.nullable(),
});
export type CollectionLatencySeries = z.infer<typeof collectionLatencySeries>;

// The bounds #64 measured its way to. A 200-collection cluster with 90 days of
// hourly readings shipped 30.9 MB of series JSON per dashboard load, of which
// the chart drew four collections — so the api sends the top few by evidence
// and says how many it did not. Shared constants because the panel explains
// the cap in the same numbers the api applies.
export const LATENCY_SERIES_WINDOW_DAYS = 30;
export const LATENCY_SERIES_MAX_COLLECTIONS = 8;

export const clusterLatencySeries = z.object({
  clusterId: z.uuid(),
  // How many collections had readings in the window — the honest denominator
  // when `collections` is the capped top slice of them.
  totalCollections: z.int().nonnegative(),
  collections: z.array(collectionLatencySeries),
});
export type ClusterLatencySeries = z.infer<typeof clusterLatencySeries>;

// One replica-set member's share of an index's operations (#161).
//
// The whole point of collecting per member. An index with 40,000 ops that are
// ALL on one secondary is a different object from one with 40,000 spread evenly:
// the first is serving a reporting replica or an analytics client with a read
// preference, and dropping it breaks something nobody was watching; the second
// is serving the application. Summed, they were the same row on this dashboard.
export const memberOps = z.object({
  member: z.string(),
  ops: z.int().nonnegative(),
});
export type MemberOps = z.infer<typeof memberOps>;

// What the last collect saw of one index's usage, per member.
export const indexUsage = z.object({
  recommendationId: z.uuid(),
  // The number that was already on screen, kept: it is still the right headline,
  // and the split is what it was missing.
  totalOps: z.int().nonnegative(),
  // Only the members that ANSWERED and reported this index. A member the collect
  // could not reach is not in here and must not be drawn as a zero — the roster
  // (getNodes) is what names it, and the two are read together.
  perMember: z.array(memberOps),
  // When this reading was last confirmed. A per-node split from a collect that
  // failed three days ago is a claim about three days ago.
  observedAt: z.string(),
});
export type IndexUsage = z.infer<typeof indexUsage>;

// One day's total index footprint for a cluster (#160).
//
// `totalBytes` is null for a day nothing was collected, and that distinction is
// the whole reason this is bucketed on the server. Zero would mean "this cluster
// had no indexes", which is a claim about the cluster; null means "nobody
// looked", which is a claim about us — and a straight line drawn across a week
// of outage says the footprint held steady when nothing was known about it.
export const indexSizePoint = z.object({
  day: z.string(),
  totalBytes: z.number().int().nonnegative().nullable(),
  // How many indexes that total is the sum of. Zero exactly when totalBytes is
  // null, and worth carrying: a footprint that fell because 40 indexes became 30
  // is a different event from one that fell because 40 indexes got smaller.
  indexCount: z.int().nonnegative(),
});
export type IndexSizePoint = z.infer<typeof indexSizePoint>;

// Total index bytes per day over the same window the latency series uses.
//
// The question the ROI panel cannot answer. ROI is cumulative and only ever goes
// up, because it counts what the engine removed; neither of its numbers says
// whether the cluster's footprint is smaller than it was. A cluster where the
// engine freed 4 GB while the application added 6 GB has a triumphant ROI panel
// and a bill that went up, and nothing on the dashboard used to show that.
export const clusterIndexSizeSeries = z.object({
  clusterId: z.uuid(),
  // The two ends of the drawable series and the distance between them, resolved
  // here rather than on the client: the series has holes in it, so "the first
  // point" and "points[0]" are not the same thing, and getting that wrong would
  // report a gap day as a footprint of zero.
  firstBytes: z.number().int().nonnegative().nullable(),
  latestBytes: z.number().int().nonnegative().nullable(),
  // Negative = the cluster carries less index than it did. Null until two
  // different days have been collected, because one point is not a trend.
  changeBytes: z.number().int().nullable(),
  points: z.array(indexSizePoint),
});
export type ClusterIndexSizeSeries = z.infer<typeof clusterIndexSizeSeries>;

// Same treatment for the proposals: 4,000 of them (the one-per-index worst
// case) measured 1.86 MB. The cap keeps the client-side sort and filter D33
// decided (they work over what arrives), and `total` keeps the truncation
// honest — "showing 500 of 4,000" instead of a table that silently claims to
// be everything.
export const RECOMMENDATIONS_CAP = 500;

// Why the engine had nothing to say (#277).
//
// An empty recommendations list is indistinguishable from "your indexes are all
// fine", and on a cluster whose usage counters reset oftener than the observation
// window the usage gate refuses every eligible index, indefinitely, with nothing
// anywhere saying so. This is that state, made a thing the dashboard can draw.
export const usageTrustRefusalKind = z.enum([
  "counters-reset",
  "no-history",
  "too-few-collects",
  "span-too-short",
  "collection-idle",
  "gap-inside-run",
  "gap-between-runs",
  "history-stale",
]);
export type UsageTrustRefusalKind = z.infer<typeof usageTrustRefusalKind>;

// A finding the engine derived and then withheld, by which guard.
export const suppressionGuard = z.enum(["cooldown", "watched", "standing", "hinted", "budget"]);
export type SuppressionGuard = z.infer<typeof suppressionGuard>;

export const suppressedFindings = z.object({
  guard: suppressionGuard,
  findings: z.int().positive(),
  // The engine's own sentence for it. Written server-side because the counts mean
  // nothing without the reason, and the reason is a fact about the pipeline.
  explanation: z.string(),
});
export type SuppressedFindings = z.infer<typeof suppressedFindings>;

export const analysisNote = z.object({
  // When the pass that wrote this ran. Stale by at most one classify cadence,
  // which is the trade: the alternative is recomputing the whole usage history on
  // every dashboard load.
  decidedAt: z.string(),
  consideredIndexes: z.int().nonnegative(),
  trustedIndexes: z.int().nonnegative(),
  // True only when NOTHING cleared the usage gate. One trusted index means the
  // machinery works and the rest are individually short of history, which is an
  // ordinary state and must not be drawn as a fault.
  usagePaused: z.boolean(),
  // The refusal accounting for the most indexes, and the sentence for it. Null
  // when nothing was refused.
  dominantRefusal: usageTrustRefusalKind.nullable(),
  refusedIndexes: z.int().nonnegative(),
  explanation: z.string().nullable(),
  suppressed: z.array(suppressedFindings),
});
export type AnalysisNote = z.infer<typeof analysisNote>;

export const clusterRecommendations = z.object({
  clusterId: z.uuid(),
  total: z.int().nonnegative(),
  recommendations: z.array(recommendation),
  // Beside the rows rather than on them (#161), and that is not a style choice:
  // `recommendation` is also what approve, undo and un-hide return, and those
  // answer about a ROW. A usage field on that shape would come back null from
  // every mutation and read as "this index has no recorded usage", which is a
  // measurement none of them took.
  //
  // Absent for an index the last collect did not see — dropped since, or a
  // collect that never reached the member holding it.
  usage: z.array(indexUsage),
  // Why the list is as short as it is (#277). Null before the first classify
  // pass has run for this cluster — which is itself the honest answer, and the
  // dashboard draws nothing rather than guessing.
  analysis: analysisNote.nullable(),
});
export type ClusterRecommendations = z.infer<typeof clusterRecommendations>;

// One executed operation from the immutable audit trail.
export const auditAction = z.object({
  id: z.uuid(),
  kind: z.string(),
  actor: z.string(),
  result: z.string(),
  database: z.string(),
  collection: z.string(),
  indexName: z.string(),
  createdAt: z.string(),
});
export type AuditAction = z.infer<typeof auditAction>;

// The per-cluster worker passes, as the schedule names them (jobs/tasks.ts).
export const clusterTask = z.enum(["collect", "classify", "suggest", "apply", "finalize", "probe"]);
export type ClusterTask = z.infer<typeof clusterTask>;

// One live event on a cluster's SSE stream (listClusterEvents). The payload is
// deliberately a signal, not state: the dashboard reacts by invalidating the
// matching queries and refetching through the same reads it already has, so
// there is never a second copy of a row to drift from the first.
//
// PASS_FINISHED says a worker pass landed and names which, so the client can
// invalidate what that pass writes and nothing else. The other three are the
// transitions worth reacting to mid-pass — they move the recommendation table,
// the audit trail and the ROI headline the moment they happen, not when the
// whole pass ends.
export const clusterEvent = z.object({
  kind: z.enum(["PASS_FINISHED", "DROP_HIDDEN", "BUILD_GRADUATED", "REGRESSION_FIRED"]),
  // Which pass, for PASS_FINISHED; null on the three transition events.
  task: clusterTask.nullable(),
});
export type ClusterEvent = z.infer<typeof clusterEvent>;

// Per-cluster engine knobs. maxCollectionSizeBytes null = no ceiling.
//
// The bounds carry messages because inputs.ts derives the policy form's
// validator from this schema, so each one is read by whoever typed the number
// as well as by the api that refused it.
export const clusterPolicy = z.object({
  clusterId: z.uuid(),
  workloadAnalysis: z.boolean(),
  instantCreate: z.boolean(),
  observeWindowDays: z
    .number()
    .int("Whole days only")
    .min(1, "At least a day")
    .max(365, "A year at most"),
  maxCollectionSizeBytes: z.number().int().positive().nullable(),
  // The one auto-approval control: null = nothing auto-approves and a human
  // clicks, 0 = everything does, anything between is a confidence floor.
  // ADVISORY_REVIEW is never auto-approved at any setting.
  autoApplyScore: z
    .number()
    .int("Whole numbers only")
    .min(0, "0 to 100")
    .max(100, "0 to 100")
    .nullable(),
  // Elective changes (hide/build/drop) run only inside this UTC hour window;
  // safety responses never wait. Null hands the choice to the engine, which
  // derives one from observed traffic; start > end wraps midnight.
  changeWindowStartHour: z.int().min(0, "0 to 23").max(23, "0 to 23").nullable(),
  changeWindowEndHour: z.int().min(0, "0 to 23").max(23, "0 to 23").nullable(),
});
export type ClusterPolicy = z.infer<typeof clusterPolicy>;

// Read-only companion to the knobs above: the window the engine chose for
// itself, and why. Separate so updatePolicy cannot be asked to set it.
export const clusterPolicyView = clusterPolicy.extend({
  inferredWindowStartHour: z.int().min(0).max(23).nullable(),
  inferredWindowEndHour: z.int().min(0).max(23).nullable(),
  inferredWindowReason: z.string().nullable(),
});
export type ClusterPolicyView = z.infer<typeof clusterPolicyView>;

// The 23 acts the security trail records (#53), and the one list of them.
//
// It lived in the api (`src/audit/security-events.ts`) while nothing read the
// table. A screen needs the same list to label rows and to offer the kind
// filter, and two copies of it would drift the moment an act is added — so the
// names live here and the writer imports them. The per-act metadata SHAPES stay
// in the api, where the call sites that fill them in are.
//
// Text in the column, not an enum, on purpose: recording a new kind of act
// should be a constant and not a migration (db/schema.ts). The api validates
// nothing against this on the way IN — an older row whose act has since been
// renamed still has to read — so `securityEvent.event` below is a string.
export const SECURITY_EVENTS = [
  // Authentication.
  "ACCOUNT_CREATED",
  "SIGN_IN",
  "SIGN_IN_FAILED",
  "SIGN_OUT",
  "SESSION_REVOKED",
  // The second factor (#55).
  "TWO_FACTOR_ENABLED",
  "TWO_FACTOR_DISABLED",
  "TWO_FACTOR_VERIFIED",
  "TWO_FACTOR_FAILED",
  "TWO_FACTOR_CODES_REGENERATED",
  "TWO_FACTOR_OTP_SENT",
  // The account.
  "EMAIL_CHANGE_REQUESTED",
  // Membership — the acts that decide who can do everything else.
  "MEMBER_ROLE_CHANGED",
  "MEMBER_REMOVED",
  "MEMBER_LEFT",
  "INVITE_CREATED",
  "INVITE_ACCEPTED",
  "ORG_CREATED",
  "ORG_DELETED",
  // The org's security posture (#313). Not membership and not a cluster, so it
  // sits with the org acts: turning "refuse credentials broader than the engine
  // needs" OFF is a decision an incident wants dated and attributed, because
  // every connect after it is one this install would previously have refused.
  "ORG_POLICY_CHANGED",
  // A cluster's access, which is what the control plane holds of a customer's.
  "CLUSTER_CONNECTED",
  "CLUSTER_DISCONNECTED",
  "CLUSTER_CREDENTIALS_ROTATED",
  "CLUSTER_MODE_CHANGED",
  // Which of a customer's databases the control plane reads (#244). The same class
  // of act as the three above: it does not change what we hold, it changes how
  // much of somebody's cluster we look at, and an owner narrowing it wants that
  // recorded as much as an incident reader wants to see it widened.
  "CLUSTER_OBSERVED_DATABASES_CHANGED",
] as const;

export type SecurityEventName = (typeof SECURITY_EVENTS)[number];

// The acts where the ADDRESS ON THE ROW IS NOT SOMEBODY WHO DID SOMETHING.
//
// `SIGN_IN_FAILED` deliberately records the address that was typed as the
// TARGET and leaves the actor null, because whoever it was did not prove they
// were that person (db/schema.ts). A screen that draws every row as
// "<address> did <act>" turns that into an accusation against the account
// holder — who, in the case worth reading, is the victim. The same applies to a
// failed second factor.
//
// Exported so the screen and its tests read the rule from one place rather than
// each spelling out a pair of event names.
export const UNPROVEN_ACTOR_EVENTS: readonly SecurityEventName[] = [
  "SIGN_IN_FAILED",
  "TWO_FACTOR_FAILED",
];

// One row of the trail.
//
// `event` is a string rather than the enum above: the column is text so that
// adding an act is a constant, and a row written under a name this build does
// not know still has to render. The screen labels what it recognises and shows
// the raw name for what it does not.
export const securityEvent = z.object({
  id: z.uuid(),
  event: z.string(),
  // Null once the account is deleted — every foreign key on this table is
  // `set null` so that deleting an org, a cluster or a user cannot erase the
  // trail of what was done to it. The email beside it is kept for exactly that
  // moment, and is what the screen shows.
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  target: z.string().nullable(),
  clusterId: z.uuid().nullable(),
  // The specifics of the act — the roles either side of a promotion, the mode a
  // cluster was flipped to. Never credentials. Loose here for the same reason
  // the column is: the shape differs per act.
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
});
export type SecurityEvent = z.infer<typeof securityEvent>;

// One page of it. The trail never ages out — retention skips it deliberately,
// because the incident that needs a row is usually older than the day it is
// noticed — so it is the one table that grows forever and the read has to be
// paged rather than capped.
export const SECURITY_TRAIL_PAGE = 100;

export const securityTrail = z.object({
  events: z.array(securityEvent),
  // How many rows match the filter, so a page can say "100 of 4,312" instead of
  // implying it is everything.
  total: z.int().nonnegative(),
  // The cursor for the page after this one, or null at the end of the trail.
  // A compound key, not a timestamp: two acts can land in the same microsecond
  // (an invite accepted is a membership row and a session), and a cursor that
  // is only a time would skip whichever one sorted second.
  nextCreatedAt: z.string().nullable(),
  nextId: z.uuid().nullable(),
});
export type SecurityTrail = z.infer<typeof securityTrail>;

export const orgMember = z.object({
  // The membership row's id, which is what the plugin's updateMemberRole and
  // removeMember take — not the user's. One person can be a member of several
  // orgs, so "which member" is a different question from "which user".
  memberId: z.uuid(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
});
export type OrgMember = z.infer<typeof orgMember>;

// What the org's plan allows, resolved server-side. Sent with the org so the
// dashboard can show a limit before someone hits it, rather than only
// explaining the 402 afterwards. Null means no limit.
export const planInfo = z.object({
  plan: z.string(),
  maxClusters: z.number().nullable(),
  maxMembers: z.number().nullable(),
  workloadAnalysis: z.boolean(),
  // Whether the engine may approve and build without a human. The paid line,
  // and the one the dashboard has to show — a limit nobody sees until it
  // refuses them is a support email.
  autoApply: z.boolean(),
  clustersUsed: z.number(),
  membersUsed: z.number(),
});
export type PlanInfo = z.infer<typeof planInfo>;

// A least-privilege user Indexterity created on someone else's cluster during
// admin-string onboarding. Cascades delete our rows; they do not touch these.
//
// Carried on the org so the delete dialog can name them BEFORE the org goes,
// which is the only moment there is anything left to name them from — afterwards
// the owner has no record of which server the user is on or what it was called.
export const provisionedUser = z.object({
  cluster: z.string(),
  username: z.string(),
  revokeCommand: z.string(),
});
export type ProvisionedUser = z.infer<typeof provisionedUser>;

// An invitation the CALLER has been sent, from any org.
//
// The credential changed with the plugin. It used to be a bearer token: an
// opaque string mailed out, pasted into a box, and good for whoever held it.
// Now the id is not a secret and only the invited address can accept, so an
// invitation is something the api can safely SHOW you — which is also why this
// is a list of your own rather than a field you type into.
//
// Read outside any org, because someone with no organization at all is exactly
// who most needs it.
export const myInvite = z.object({
  id: z.uuid(),
  orgName: z.string(),
  role: z.string(),
  expiresAt: z.string(),
});
export type MyInvite = z.infer<typeof myInvite>;

// The org's own policy — the rules that apply before a cluster exists (#313).
//
// One field today and a shape rather than a bare boolean, because the thing it
// is: `policies` next door started as three knobs and the route that replaces
// them whole has not changed shape since. An org-level rule that has to be read
// on the connect path wants the same room.
export const orgPolicyView = z.object({
  // Refuse to store credentials broader than the engine needs, at connect and at
  // rotate. Off unless an owner turned it on — an install that has said nothing
  // has not asked us to refuse anybody's string.
  requireLeastPrivilege: z.boolean(),
  // Null until somebody saves one, which is what distinguishes "off" from "never
  // configured" — the distinction #258 found the per-cluster toggle was missing.
  updatedAt: z.string().nullable(),
});
export type OrgPolicyView = z.infer<typeof orgPolicyView>;

export const orgInfo = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  plan: planInfo,
  // The caller's own role in this org, so the dashboard can draw the owner-only
  // controls without inferring it from the member list.
  role: z.string(),
  members: z.array(orgMember),
  pendingInvites: z.array(
    z.object({ id: z.uuid(), email: z.string(), role: z.string(), expiresAt: z.string() }),
  ),
  provisionedUsers: z.array(provisionedUser),
  // The org's policy, on the payload the whole dashboard already reads. It is
  // needed in two places at once — the Settings toggle that owns it, and every
  // connection card that has to say whether its cluster is out of policy — and a
  // second endpoint for one boolean would mean the card either fetches it per
  // cluster or renders before knowing.
  policy: orgPolicyView,
});
export type OrgInfo = z.infer<typeof orgInfo>;

// A WireGuard peering the control plane terminates, so a cluster with no public
// endpoint can be reached (#353).
//
// The config's SECRET half never appears here. The [Interface] PrivateKey is a
// credential of the same weight as a connection string, and the dashboard has
// no use for it: what an owner needs to see is which network this reaches and
// whether the handshake is current. Everything below is derived from the sealed
// config server-side rather than stored twice.
export const tunnelHealth = z.enum(["UP", "HANDSHAKING", "DOWN", "IDLE"]);
export type TunnelHealth = z.infer<typeof tunnelHealth>;

export const tunnelView = z.object({
  id: z.uuid(),
  name: z.string(),
  // host:port of the customer's gateway. Not a secret — it is an address they
  // published to their own VPN clients — and it is the field that identifies
  // which network this is at a glance.
  endpoint: z.string(),
  allowedIps: z.array(z.string()),
  // Whose resolver answers names inside the tunnel. Empty when the config
  // carried no DNS, which is worth showing: a cluster addressed by name will
  // not resolve, and that failure otherwise reads as "unreachable".
  dns: z.array(z.string()),
  // IDLE means the tunnel has never been asked for since this process started.
  // It is not a fault — tunnels come up on first use — and it must not be drawn
  // as one.
  health: tunnelHealth,
  // Seconds since the last completed handshake; null when there has not been
  // one in this process. A stale handshake is a condition of the TUNNEL, not of
  // the clusters behind it.
  handshakeAgeSeconds: z.number().nullable(),
  // How many clusters would break if this were deleted, which is why the delete
  // is refused while it is non-zero.
  clusterCount: z.number().int(),
  createdAt: z.string(),
});
export type TunnelView = z.infer<typeof tunnelView>;
