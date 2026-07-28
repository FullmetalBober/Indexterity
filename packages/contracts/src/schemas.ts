import { z } from "zod";

export const recommendationType = z.enum([
  "DROP_UNUSED",
  "DROP_REDUNDANT",
  "MERGE",
  "CREATE",
  "UPDATE",
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
  id: z.string().uuid(),
  name: z.string(),
  connectionMode,
  readOnly: z.boolean(),
  createdAt: z.string(),
});
export type Cluster = z.infer<typeof cluster>;

export const recommendation = z.object({
  id: z.string().uuid(),
  clusterId: z.string().uuid(),
  type: recommendationType,
  usageClass: usageClass.nullable(),
  state: recommendationState,
  database: z.string(),
  collection: z.string(),
  indexName: z.string(),
  rationale: z.string(),
  estimatedBytesSaved: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Recommendation = z.infer<typeof recommendation>;

export const clusterRoi = z.object({
  clusterId: z.string().uuid(),
  freedBytes: z.number().int().nonnegative(),
  indexesDropped: z.number().int().nonnegative(),
  estimatedMonthlyUsd: z.number().nonnegative(),
});
export type ClusterRoi = z.infer<typeof clusterRoi>;

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
  clusterId: z.string().uuid(),
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
  clusterId: z.string().uuid(),
  collections: z.array(collectionLatencySeries),
});
export type ClusterLatencySeries = z.infer<typeof clusterLatencySeries>;

export const orgMember = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
});
export type OrgMember = z.infer<typeof orgMember>;

export const orgInfo = z.object({
  id: z.string().uuid(),
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
