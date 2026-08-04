import { z } from "zod";

export const recommendationType = z.enum([
  "DROP_UNUSED",
  "DROP_REDUNDANT",
  "MERGE",
  "CREATE",
  "UPDATE",
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

// The database engine behind a cluster. Only MONGODB connects today; the enum
// is the forward-compatible surface for the planned PostgreSQL/SQL Server
// adapters (the wiki's Architecture page, Engine ports).
export const clusterEngine = z.enum(["MONGODB", "POSTGRESQL", "MSSQL"]);
export type ClusterEngine = z.infer<typeof clusterEngine>;

export const cluster = z.object({
  id: z.uuid(),
  name: z.string(),
  connectionMode,
  engine: clusterEngine,
  readOnly: z.boolean(),
  // Set when Indexterity provisioned its own least-privilege user on the
  // cluster (admin-string onboarding); null for pasted-string clusters.
  provisionedUsername: z.string().nullable(),
  // Newest index snapshot, or null before the first collect. The dashboard
  // flags stale data so numbers from before an outage cannot read as current.
  lastCollectedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Cluster = z.infer<typeof cluster>;

// One privilege the engine needs and whether the credentials have it.
// CORE = analysis impossible without it; APPLY = analysis-only without it;
// WORKLOAD = an optional signal source.
export const privilegeTier = z.enum(["CORE", "APPLY", "WORKLOAD"]);
export type PrivilegeTier = z.infer<typeof privilegeTier>;

export const privilegeCheck = z.object({
  key: z.string(),
  label: z.string(),
  enables: z.string(),
  tier: privilegeTier,
  granted: z.boolean(),
});
export type PrivilegeCheck = z.infer<typeof privilegeCheck>;

// What a pasted connection string can actually do — computed before anything
// is stored, so onboarding can name what is missing or offer to provision.
export const connectionDiagnosis = z.object({
  reachable: z.boolean(),
  message: z.string().nullable(),
  username: z.string().nullable(),
  authEnabled: z.boolean(),
  canProvision: z.boolean(),
  ready: z.boolean(),
  canApply: z.boolean(),
  privileges: z.array(privilegeCheck),
  missing: z.array(z.string()),
});
export type ConnectionDiagnosis = z.infer<typeof connectionDiagnosis>;

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

// The result of disconnecting a cluster: how many in-flight hidden indexes were
// restored, and the command to revoke the provisioned user (null when the
// cluster was connected with a pasted string).
export const offboardResult = z.object({
  unhidden: z.int().nonnegative(),
  revokeCommand: z.string().nullable(),
});
export type OffboardResult = z.infer<typeof offboardResult>;

// One org the caller belongs to — the switcher's option list.
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

export const collectionLatencySeries = z.object({
  database: z.string(),
  collection: z.string(),
  points: z.array(latencySeriesPoint),
});
export type CollectionLatencySeries = z.infer<typeof collectionLatencySeries>;

export const clusterLatencySeries = z.object({
  clusterId: z.uuid(),
  collections: z.array(collectionLatencySeries),
});
export type ClusterLatencySeries = z.infer<typeof clusterLatencySeries>;

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

// Per-cluster engine knobs. maxCollectionSizeBytes null = no ceiling.
export const clusterPolicy = z.object({
  clusterId: z.uuid(),
  workloadAnalysis: z.boolean(),
  instantCreate: z.boolean(),
  observeWindowDays: z.number().int().min(1).max(365),
  maxCollectionSizeBytes: z.number().int().positive().nullable(),
  // The one auto-approval control: null = nothing auto-approves and a human
  // clicks, 0 = everything does, anything between is a confidence floor.
  // ADVISORY_REVIEW is never auto-approved at any setting.
  autoApplyScore: z.number().int().min(0).max(100).nullable(),
  // Elective changes (hide/build/drop) run only inside this UTC hour window;
  // safety responses never wait. Null hands the choice to the engine, which
  // derives one from observed traffic; start > end wraps midnight.
  changeWindowStartHour: z.int().min(0).max(23).nullable(),
  changeWindowEndHour: z.int().min(0).max(23).nullable(),
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

export const orgMember = z.object({
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

export const orgInfo = z.object({
  id: z.uuid(),
  name: z.string(),
  plan: planInfo,
  members: z.array(orgMember),
  pendingInvites: z.array(z.object({ email: z.string(), role: z.string(), expiresAt: z.string() })),
});
export type OrgInfo = z.infer<typeof orgInfo>;

// Returned once at creation — the token is the bearer credential.
export const createdInvite = z.object({
  token: z.string(),
  email: z.string(),
  role: z.string(),
  expiresAt: z.string(),
});
export type CreatedInvite = z.infer<typeof createdInvite>;
