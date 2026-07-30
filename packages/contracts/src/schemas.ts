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

// Full lifecycle across drop and create pipelines (see docs/architecture.md §7).
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

export const cluster = z.object({
  id: z.uuid(),
  name: z.string(),
  connectionMode,
  readOnly: z.boolean(),
  // Set when Indexterity provisioned its own least-privilege user on the
  // cluster (admin-string onboarding); null for pasted-string clusters.
  provisionedUsername: z.string().nullable(),
  createdAt: z.string(),
});
export type Cluster = z.infer<typeof cluster>;

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
  autoApply: z.boolean(),
  workloadAnalysis: z.boolean(),
  instantCreate: z.boolean(),
  observeWindowDays: z.number().int().min(1).max(365),
  maxCollectionSizeBytes: z.number().int().positive().nullable(),
  // Score threshold for auto-approval (null = never auto-approve by score).
  autoApplyScore: z.number().int().min(0).max(100).nullable(),
  // Elective changes (hide/build/drop) run only inside this UTC hour window;
  // safety responses never wait. Null = anytime; start > end wraps midnight.
  changeWindowStartHour: z.int().min(0).max(23).nullable(),
  changeWindowEndHour: z.int().min(0).max(23).nullable(),
});
export type ClusterPolicy = z.infer<typeof clusterPolicy>;

export const orgMember = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
});
export type OrgMember = z.infer<typeof orgMember>;

export const orgInfo = z.object({
  id: z.uuid(),
  name: z.string(),
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
