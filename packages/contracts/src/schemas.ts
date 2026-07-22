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
  demoMode: z.boolean(),
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
