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

// Why the pipeline is not running against a cluster.
//
// The condition was always known — a metric, a log line, a mail once a day — and
// none of it reached a screen, so a cluster nobody could reach looked exactly
// like a cluster with nothing to collect: `lastCollectedAt` quietly going stale.
// A problem that renders as an absence reads as "nothing is obviously wrong".
export const BLOCKED_REASONS = [
  // We dialled and nothing answered.
  "UNREACHABLE",
  // The VPN gateway did not come up. NOT unreachable: the database may be
  // answering perfectly and we never dialled it (#353).
  "TUNNEL_DOWN",
  // The stored string would connect in plaintext, so we declined to dial.
  "INSECURE",
  // The sealed credentials cannot be opened — an operator's problem.
  "CREDENTIALS",
  // A major series this release has not been probed against.
  "UNSUPPORTED",
  // A read-only pass ran past its wall-clock budget and was abandoned (#407).
  // Its own reason rather than ERROR: nothing went wrong that a message could
  // describe, and the answer is not the same — an owner reading this needs to
  // know their cluster is too slow to finish inside the schedule, not that the
  // pipeline hit something it has no name for.
  "TIMED_OUT",
  // Anything else, which is also the one that gets retried and dead-lettered.
  "ERROR",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

// An instant on the wire: ISO-8601, UTC, which is exactly what
// `Date.prototype.toISOString` produces and what every producer of every field
// below already calls.
//
// `z.string()` for nineteen fields was the same unchecked claim this repo bans
// with `as`. The type said `string`; thirteen places in the dashboard called
// `new Date()` on it and acted on a stronger claim nobody verified, and only
// three of them checked the result. An unparseable value did not fail — it
// spread. `new Date(bad).getTime() > Date.now()` is `false`, so a pending drop
// read as not pending; `(Date.now() - NaN) / 3_600_000 > 48` is `false`, so the
// staleness badge that exists to stop old numbers reading as current never drew;
// two more rendered the literal string "Invalid Date"; and
// `formatTimestamp` called `.toISOString()` on it, which THROWS — during SSR.
//
// A problem that renders as an absence reads as "nothing is obviously wrong",
// which is the failure BLOCKED_REASONS above exists to stop. So the boundary
// says what it means and oRPC's output validation enforces it: a bad instant is
// now a failed read, which the dashboard already knows how to draw, instead of
// nine screens quietly disagreeing about what a timestamp is.
//
// UTC only, deliberately — no offset form. `toISOString` never emits one, so
// accepting `+02:00` would only widen what the api may send without widening
// what any reader was written for.
export const instant = z.iso.datetime();

export const clusterBlock = z.object({
  // A string rather than the enum above, deliberately. The column is text so
  // that adding a reason is a constant rather than a migration — and a reason
  // written by a newer worker than the api reading it must render as itself
  // rather than fail the whole cluster read, which is the failure this field
  // exists to stop happening.
  reason: z.string(),
  // When it STARTED, not when it was last seen: "for six days" is the part that
  // decides whether somebody acts.
  since: instant,
  // The sentence, usually the driver's own words.
  detail: z.string(),
  // WHICH pass stopped — `collect`, `suggest`, `apply` and so on (#408).
  //
  // A string for the same reason `reason` is one, and nullable for a second:
  // rows written before this field existed have no pass, and a block that
  // predates the upgrade must still render. The dashboard therefore has to have
  // wording for "something in the pipeline" as well as for a named pass, which
  // is the wording it used to use for everything.
  task: z.string().nullable(),
});
export type ClusterBlock = z.infer<typeof clusterBlock>;

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
  lastCollectedAt: instant.nullable(),
  // Null when the pipeline is running. When it is not, this is the answer to
  // "why are these numbers old", which staleness alone cannot give.
  blocked: clusterBlock.nullable(),
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
  createdAt: instant,
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
  checkedAt: instant,
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
  hiddenAt: instant.nullable(),
  observeDays: z.number().int().positive().nullable(),
  // And why that window, when it differs from the policy baseline. The number
  // alone reads as arbitrary next to another row with a different one; this is
  // the sentence the engine already wrote to explain it.
  observeReason: z.string().nullable(),
  createdAt: instant,
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

// How many indexes one page of the inventory carries (#431).
//
// The dev cluster has 211; a real one has more, and every row carries a key
// pattern and a per-member split, so this is the read that would otherwise grow
// with the customer's index count forever — the unbounded shape #64 bounded
// everywhere else. 100 measured ~46 KB against the dev cluster's widest
// namespaces, which is a page rather than a payload.
export const CLUSTER_INDEXES_PAGE = 100;

// The sizes the page-size control offers, and the only ones it may ask for.
//
// A list rather than a range, so the api and the control cannot disagree about
// what is allowed, and small enough at the low end that a page number is worth
// having: 517 indexes is six pages at 100 and twenty-one at 25.
export const CLUSTER_INDEXES_PAGE_SIZES = [25, 50, 100] as const;

// The largest page this endpoint will serve. Not one of the offered sizes — it
// bounds a hand-written request, and it is what keeps this a page rather than a
// report whatever a caller asks for.
export const CLUSTER_INDEXES_PAGE_MAX = 200;

// One key of an index, in the order the index declares it. The direction
// vocabulary is the adapters' (engine/types.ts): a relational engine only ever
// reports 1 or -1, and the four MongoDB special forms are what the others
// cannot express.
//
// `2d` is the legacy geo form and it has to be here rather than only in the
// adapter: this schema is what the inventory route answers with, so a union
// missing a form the collector reports does not degrade — it throws, and a failed
// read renders as "this cluster has no indexes" (D129).
export const indexKeyView = z.object({
  field: z.string(),
  direction: z.union([
    z.literal(1),
    z.literal(-1),
    z.literal("2d"),
    z.literal("2dsphere"),
    z.literal("text"),
    z.literal("hashed"),
  ]),
});
export type IndexKeyView = z.infer<typeof indexKeyView>;

// One member's share of an index's operations, with the counter start beside it.
//
// `since` is the difference between this and `memberOps`, and it is the whole
// reason the inventory does not reuse that schema: `$indexStats` counters are
// cumulative from the moment the member came up, so "0 ops" on a member that
// restarted an hour ago is not idleness (D114). Null when the reading predates
// the field being captured, which is not the same as "the counter started at
// the epoch".
export const indexMemberUsage = z.object({
  member: z.string(),
  ops: z.int().nonnegative(),
  since: instant.nullable(),
});
export type IndexMemberUsage = z.infer<typeof indexMemberUsage>;

// A recommendation that currently points at an index, so the row can link to it
// rather than leaving the reader to find out on another page whether the engine
// has an opinion. Null for the indexes nobody has proposed anything about —
// which is most of them, and the population this page exists to show.
export const indexRecommendationLink = z.object({
  id: z.uuid(),
  type: recommendationType,
  state: recommendationState,
});
export type IndexRecommendationLink = z.infer<typeof indexRecommendationLink>;

// One index the cluster actually has, as of the latest collect (#431).
//
// Everything here was already stored — `cluster_indexes` carries the identity
// and the spec, `index_snapshots` the size and the per-member counters — and
// none of it had anywhere to be looked at: index-level numbers reached the
// dashboard only as `IndexUsage`, keyed by `recommendationId` (D66), so an index
// nobody had proposed anything about had no row on any screen.
//
// The flags are carried as the booleans the adapters set rather than as a
// rendered list, and they are NOT all meaningful on every engine: PostgreSQL
// reports no TTL, no sparse and no hidden (its collector hardcodes all three,
// and D106 is why the last one), SQL Server reports `hidden` as a disabled index
// and no TTL or sparse. `isShardKey` is the port's "the cluster does not work
// without this" flag and means a shard key, a primary key and a clustered index
// on the three engines — so the WORDING is resolved against the cluster's engine
// by index-flags.ts rather than being fixed here.
export const clusterIndexRow = z.object({
  // The dimension row's id, which is the page's stable row key. Not the
  // namespace-plus-name triple: a rebuilt index has a second dimension row (the
  // table is keyed by spec digest), and only one of them is the live one.
  id: z.uuid(),
  database: z.string(),
  collection: z.string(),
  indexName: z.string(),
  keys: z.array(indexKeyView),
  // Carried at the leaves without being ordered by — SQL Server's INCLUDE.
  // Empty on the engines that have no such concept, which is every engine but
  // that one.
  include: z.array(z.string()),
  unique: z.boolean(),
  ttl: z.boolean(),
  partial: z.boolean(),
  // The predicate itself, not just whether there is one: two partial indexes
  // are only interchangeable if they filter on the same thing. A mongo
  // expression, `{ sql: … }` from PostgreSQL, `{ definition: … }` from SQL
  // Server — rendered as text, never interpreted.
  partialFilter: z.record(z.string(), z.unknown()).nullable(),
  sparse: z.boolean(),
  hidden: z.boolean(),
  isShardKey: z.boolean(),
  collation: z.string().nullable(),
  // Seen as the target of a hint() in the profiler window. The engine will not
  // re-order or hide a hinted index (analysis/reorder.ts), so this is a state
  // the customer could previously only infer from a recommendation's absence.
  hinted: z.boolean(),
  sizeBytes: z.int().nonnegative(),
  // Summed across the members that ANSWERED. The split is beside it because the
  // split is the finding (D66) — 40,000 ops all on one secondary is a reporting
  // replica, and the same total spread evenly is the application.
  totalOps: z.int().nonnegative(),
  perMember: z.array(indexMemberUsage),
  // When this reading was last confirmed still true — `last_seen_at`, the run's
  // end, not its start. A page drawn from a collect that failed three days ago
  // is a claim about three days ago, so the age travels with the number.
  observedAt: instant,
  recommendation: indexRecommendationLink.nullable(),
});
export type ClusterIndexRow = z.infer<typeof clusterIndexRow>;

// One page of the cluster's index inventory.
export const clusterIndexes = z.object({
  clusterId: z.uuid(),
  indexes: z.array(clusterIndexRow),
  // How many indexes MATCH — the whole cluster's, or the namespace filter's, so
  // a page can say "100 of 211" instead of implying it is everything.
  //
  // Load-bearing since #445 rather than only wording: it is the row count the
  // table's pagination reads to know how many pages exist, and it is re-counted
  // per request so the page count follows a set that moved (D133).
  total: z.int().nonnegative(),
  // Where this page actually starts, echoed rather than assumed. The reader asked
  // for an offset and may not have got it: past the end of a set that shrank, the
  // api clamps to the last page rather than serving an empty one, and the control
  // has to move with it or it would keep saying page five of three.
  offset: z.int().nonnegative(),
  // How many rows the page carries at most, which is the page size in effect. The
  // api owns the default, so a caller that sent no limit still learns what it got.
  limit: z.int().positive(),
  // When the reading these rows come from was taken. Null when nothing has ever
  // been collected, which is the page's "nothing yet" state rather than "this
  // cluster has no indexes".
  collectedAt: instant.nullable(),
});
export type ClusterIndexes = z.infer<typeof clusterIndexes>;

// How many scanning shapes one page of the workload view carries (#432).
//
// Smaller than the index page's because a row here is wider — the ESR split, the
// clients, and a sentence explaining the gate — and because these are ranked by
// cost rather than browsed by namespace: the worst ones are the answer, and a
// reader who needs the fiftieth is looking at a different problem.
export const WORKLOAD_SHAPES_PAGE = 50;

// What the create side decided about a scanning shape. `proposed` is the only
// one that means an index was recommended; every other value names the gate that
// declined, and each gate is correct — see analysis/workload-outcome.ts, which
// owns the sentence for each.
export const workloadOutcome = z.enum([
  "proposed",
  "below-cost-floor",
  "not-recurring",
  "ad-hoc-client",
  "cooldown",
  "standing",
  "index-exists",
  "no-candidate",
]);
export type WorkloadOutcome = z.infer<typeof workloadOutcome>;

// One client as the workload source described it. An appName from a connection
// string and the driver's own name — operational metadata, never customer data,
// and the signal behind the `ad-hoc-client` outcome.
export const workloadClient = z.object({
  application: z.string().nullable(),
  driver: z.string().nullable(),
});
export type WorkloadClient = z.infer<typeof workloadClient>;

// A scanning query shape, in ESR terms: what an index would have to cover.
//
// Equality first, then sort, then range — the order that lets ONE index serve
// the whole query. Sort keys keep their directions because an index can only
// serve a sort in the order it was built; equality and range keys do not, since
// direction is irrelevant to a point or a bound.
export const workloadShapeKeys = z.object({
  equality: z.array(z.string()),
  sort: z.array(z.object({ field: z.string(), direction: z.union([z.literal(1), z.literal(-1)]) })),
  range: z.array(z.string()),
});
export type WorkloadShapeKeys = z.infer<typeof workloadShapeKeys>;

// One scanning shape the engine saw, priced, and either proposed an index for or
// declined (#432).
//
// `collscan` and `sortedInMemory` are separate booleans rather than one enum
// because a shape can be both, and because they are different failures: a scan
// found no index at all, while an in-memory sort found the documents through an
// index and could not ORDER them. The second is invisible to every scan test —
// keys were examined, so by that measure the query looks healthy — and it is the
// one that ends in an ERROR rather than in slowness, since a blocking sort dies
// at 100 MB.
export const workloadShape = z.object({
  id: z.uuid(),
  database: z.string(),
  collection: z.string(),
  keys: workloadShapeKeys,
  collscan: z.boolean(),
  sortedInMemory: z.boolean(),
  // Cumulative from the workload store's own start, not per pass: `$queryStats`
  // accumulates for the life of the store and the profiler's ring reports what
  // it still holds. Which is why the rate below is a quotient rather than a
  // difference between two readings (D26).
  executions: z.int().nonnegative(),
  // Documents the server actually walked — D40's urgency measure. Null where the
  // source cannot say: `$queryStats` reports it only from mongo 8.0, and zero
  // would be a claim that a collection scan walked nothing.
  docsExamined: z.int().nonnegative().nullable(),
  // The window the rate is over. Null when the source cannot say, which is not
  // the same as zero.
  observedForHours: z.number().nonnegative().nullable(),
  // Documents walked per week, as the severity tiers actually measure it
  // (analysis/severity.ts: >=10M/week or >=500k per execution is critical,
  // >=1M elevated). Computed server-side because the tier is, and two places
  // dividing by an optional window is how they come to disagree.
  weeklyDocsExamined: z.int().nonnegative().nullable(),
  severity: z.enum(["CRITICAL", "ELEVATED", "ROUTINE"]),
  clients: z.array(workloadClient),
  outcome: workloadOutcome.nullable(),
  // Verbatim, when the api did not recognise the outcome — a row written by a
  // newer worker than the api reading it renders as itself rather than failing
  // the page (the column is text for exactly this).
  outcomeRaw: z.string(),
  // The engine's own sentence for that outcome. Null when the outcome is not one
  // this build knows how to explain.
  explanation: z.string().nullable(),
  // The index that WAS proposed, when one was. Null for every declined outcome.
  proposedIndex: z.string().nullable(),
  // When this shape was first seen scanning, and when that was last true. The
  // pair is the whole answer to "is this new": a scan that started on Tuesday
  // and one that has been there three months are otherwise the same row, and
  // they are not the same problem.
  firstSeenAt: instant,
  lastSeenAt: instant,
  observations: z.int().positive(),
});
export type WorkloadShape = z.infer<typeof workloadShape>;

// One page of the cluster's scanning workload.
export const clusterWorkload = z.object({
  clusterId: z.uuid(),
  shapes: z.array(workloadShape),
  // How many shapes match, so a page can say "50 of 312".
  total: z.int().nonnegative(),
  // The cursor for the page after this one, or null at the end. Two halves: the
  // sort is by weekly cost descending and the id breaks the tie, because two
  // shapes with the same cost on one collection is ordinary and a cursor that
  // was only the cost would skip whichever sorted second.
  nextWeeklyDocsExamined: z.int().nullable(),
  nextId: z.uuid().nullable(),
  // Whether create-side analysis is switched off for this cluster. The one gate
  // that leaves NO shape rows at all, because nothing is read when it fires — so
  // an empty page has two very different meanings and this is which one.
  workloadAnalysisEnabled: z.boolean(),
  // The two ELIGIBILITY gates, as counts of COLLECTIONS rather than rows.
  //
  // Both fire before the workload is read — `collectWorkload` is only asked
  // about the namespaces that clear them — so there are no shapes to carry an
  // outcome. Reading a workload for an ineligible namespace would mean a
  // profiler dial per collection on every cluster below MongoDB 8.0, which is a
  // real cost to pay for a row saying a 40-document collection was not
  // analysed. So the pass counts them into its own note (#277) and the page
  // reports the numbers.
  collectionsBelowDocFloor: z.int().nonnegative(),
  collectionsAboveSizeCeiling: z.int().nonnegative(),
  // When the newest reading here was taken. Null when no create-side pass has
  // ever stored a shape, which is the page's "nothing yet" state rather than
  // "this cluster scans nothing".
  analysedAt: instant.nullable(),
});
export type ClusterWorkload = z.infer<typeof clusterWorkload>;

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
  collectedAt: instant.nullable(),
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
  createdAt: instant,
  updatedAt: instant,
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
  nextEligibleAt: instant.nullable(),
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
  capturedAt: instant,
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
//
// The cap is the whole payload, and the api splits it in HALF between the two
// charts rather than ranking once for both — see `chartableCollections`. Half
// of eight is also what a chart can draw, since the palette has four colours,
// so nothing is sent that could not be shown.
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
  observedAt: instant,
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
// fine", and until #277 nothing anywhere said which of the usage gate's checks
// had refused every eligible index. This is that state, made a thing the
// dashboard can draw.
//
// `counters-reset` was one of these and is not any more: a restart segments the
// usage history rather than voiding it, so the reasons left are all about how
// much has been watched. `dominantRefusal` reads only the kinds it knows, so a
// stored count under the old key is ignored rather than failing this schema.
export const usageTrustRefusalKind = z.enum([
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
export const suppressionGuard = z.enum([
  "cooldown",
  "watched",
  "standing",
  "hinted",
  "budget",
  "unobservable",
]);
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
  decidedAt: instant,
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
  createdAt: instant,
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
  // The VPN peerings the control plane dials THROUGH (#353). Not cluster acts —
  // one tunnel commonly reaches several — and the same class of decision as the
  // cluster ones: registering one decides where we open sockets, replacing its
  // config hands us a new key for somebody's private network, and removing one
  // takes the route to every database behind it away.
  "TUNNEL_REGISTERED",
  "TUNNEL_UPDATED",
  "TUNNEL_REMOVED",
  // A reachability test, which changes nothing and is recorded anyway. It was
  // left out at first for that reason — a row per button press buries the three
  // acts above it. What changes the calculation is that a test is the one thing
  // here that reaches OUT: it sends datagrams to a customer's gateway on demand,
  // and "who probed whose network, when, and what came back" is a question an
  // incident asks. The kind filter keeps it out of the way of the rest.
  "TUNNEL_TESTED",
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
  createdAt: instant,
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
  nextCreatedAt: instant.nullable(),
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
  expiresAt: instant,
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
  updatedAt: instant.nullable(),
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
    z.object({ id: z.uuid(), email: z.string(), role: z.string(), expiresAt: instant }),
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
  createdAt: instant,
});
export type TunnelView = z.infer<typeof tunnelView>;

// What a reachability test found. A tunnel is registered from a pasted file, so
// until something dials through it the only thing that has been checked is that
// the file parses — and a wrong PublicKey or an endpoint the gateway does not
// listen on both parse perfectly. This is the answer to "would it work", asked
// on purpose rather than discovered at the first collect.
export const tunnelTestResult = z.object({
  // Did a handshake complete inside the window? The whole verdict, in one
  // field, because that is the only thing a yes/no answer can honestly claim:
  // the gateway answered us, right now.
  reachable: z.boolean(),
  health: tunnelHealth,
  handshakeAgeSeconds: z.number().nullable(),
  // Why it did not come up, verbatim from the device — a refused gateway
  // address, a name that does not resolve, a response that failed to verify.
  // Null when it did come up, and also when it simply never answered: silence
  // is what an unreachable endpoint or a wrong PublicKey both look like, and
  // inventing a cause for it would send the owner somewhere specific for a
  // reason we do not have.
  error: z.string().nullable(),
});
export type TunnelTestResult = z.infer<typeof tunnelTestResult>;
