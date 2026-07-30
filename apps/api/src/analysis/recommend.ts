import type { RecommendationType, UsageClass } from "@repo/contracts";
import { z } from "zod";
import { type ClassifyOptions, classifyUsage } from "./classify";
import { isRedundantPrefix } from "./redundancy";
import { isNeverDrop } from "./safety";
import type { IndexSpec, UsageSnapshot } from "./types";

const directionSchema = z.union([
  z.literal(1),
  z.literal(-1),
  z.literal("2dsphere"),
  z.literal("text"),
  z.literal("hashed"),
]);

const storedSpecSchema = z.object({
  name: z.string(),
  keys: z.array(z.object({ field: z.string(), direction: directionSchema })),
  unique: z.boolean(),
  ttl: z.boolean(),
  partial: z.boolean(),
  sparse: z.boolean(),
  hidden: z.boolean(),
  isShardKey: z.boolean(),
});

// Rehydrate an IndexSpec from a persisted snapshot's `spec` jsonb (no `as`).
export function parseStoredSpec(value: unknown): IndexSpec {
  return storedSpecSchema.parse(value);
}

export interface IndexInput {
  readonly spec: IndexSpec;
  readonly history: readonly UsageSnapshot[];
}

export interface RecommendationCandidate {
  readonly type: RecommendationType;
  readonly indexName: string;
  readonly usageClass: UsageClass | null;
  readonly rationale: string;
  readonly estimatedBytesSaved: number;
}

// Pure: given all indexes of one collection, propose safe drops. Never proposes
// a never-drop index (_id_/unique/TTL/shard-key/partial/sparse).
export function recommendForCollection(
  indexes: readonly IndexInput[],
  sizes: Readonly<Record<string, number>>,
  options: ClassifyOptions,
): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  const eligible = indexes.filter((index) => !isNeverDrop(index.spec));
  const redundant = new Set<string>();

  for (const candidate of eligible) {
    const covering = indexes.find((other) => isRedundantPrefix(candidate.spec, other.spec));
    if (covering !== undefined) {
      redundant.add(candidate.spec.name);
      candidates.push({
        type: "DROP_REDUNDANT",
        indexName: candidate.spec.name,
        usageClass: null,
        rationale: `Key-prefix of ${covering.spec.name}, which already covers it.`,
        estimatedBytesSaved: sizes[candidate.spec.name] ?? 0,
      });
    }
  }

  for (const index of eligible) {
    if (redundant.has(index.spec.name)) continue;
    const usageClass = classifyUsage(index.history, options);
    if (usageClass !== "FLAT_ZERO" && usageClass !== "PERIODIC_DEAD") continue;
    candidates.push({
      type: "DROP_UNUSED",
      indexName: index.spec.name,
      usageClass,
      rationale:
        usageClass === "PERIODIC_DEAD"
          ? "Was periodic, then went quiet — the workload using it appears retired."
          : "No recorded usage across the observation window.",
      estimatedBytesSaved: sizes[index.spec.name] ?? 0,
    });
  }

  // Advisory tier: protected indexes (unique/TTL/shard/partial/sparse) are never
  // auto-dropped, but one that also shows zero usage deserves a human look
  // instead of staying silent. _id_ is exempt — it is never optional.
  for (const index of indexes) {
    if (!isNeverDrop(index.spec) || index.spec.name === "_id_") continue;
    const usageClass = classifyUsage(index.history, options);
    if (usageClass !== "FLAT_ZERO" && usageClass !== "PERIODIC_DEAD") continue;
    candidates.push({
      type: "ADVISORY_REVIEW",
      indexName: index.spec.name,
      usageClass,
      rationale:
        "Protected index (unique/TTL/shard/partial/sparse) with no recorded usage — never auto-dropped; review manually.",
      estimatedBytesSaved: sizes[index.spec.name] ?? 0,
    });
  }

  return candidates;
}
