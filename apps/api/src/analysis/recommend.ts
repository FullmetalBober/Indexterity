import type { RecommendationType, UsageClass } from "@repo/contracts";
import { z } from "zod";
import { type ClassifyOptions, classifyUsage, usageHistoryIsTrustworthy } from "./classify";
import { coversIncludes, isKeyPrefix, isRedundantPrefix, servedByBackwardWalk } from "./redundancy";
import { isNeverDrop } from "./safety";
import { dropScore } from "./score";
import { type IndexSpec, totalObservations, type UsageSnapshot } from "./types";

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
  partialFilter: z.record(z.string(), z.unknown()).nullable().optional(),
  sparse: z.boolean(),
  hidden: z.boolean(),
  isShardKey: z.boolean(),
  // Older persisted specs predate collation capture — default to binary.
  collation: z.string().nullable().optional(),
  // Absent for every MongoDB index, and for SQL Server specs persisted before
  // includes were captured. Both mean the same thing to the redundancy rule:
  // nothing is known to be covered, so nothing can be lost by a drop.
  include: z.array(z.string()).optional(),
});

// Rehydrate an IndexSpec from a persisted snapshot's `spec` jsonb (no `as`).
export function parseStoredSpec(value: unknown): IndexSpec {
  const parsed = storedSpecSchema.parse(value);
  return {
    ...parsed,
    collation: parsed.collation ?? null,
    partialFilter: parsed.partialFilter ?? null,
  };
}

export interface IndexInput {
  readonly spec: IndexSpec;
  readonly history: readonly UsageSnapshot[];
  // This index already has a drop on the way — proposed, approved or hidden.
  // It still exists, so it stays in the input list, but it must not be the
  // reason another index is dropped: "covered by X" stops being true the moment
  // X leaves, and two indexes can otherwise cover each other out of existence.
  readonly pendingRemoval?: boolean;
}

export interface RecommendationCandidate {
  readonly type: RecommendationType;
  readonly indexName: string;
  readonly usageClass: UsageClass | null;
  readonly rationale: string;
  readonly score: number;
  readonly estimatedBytesSaved: number;
}

// Pure: given all indexes of one collection, propose safe drops. Never proposes
// a never-drop index (_id_/unique/TTL/shard-key/partial/sparse).
export function recommendForCollection(
  indexes: readonly IndexInput[],
  sizes: Readonly<Record<string, number>>,
  options: ClassifyOptions,
  // How much each index's regression history still counts against it, per index
  // name — a decayed weight rather than a raw count (analysis/score.ts).
  regressionWeights: Readonly<Record<string, number>> = {},
  // "Now" for the history-freshness check; injected to keep this pure.
  now: Date = new Date(),
  // Hours in which this collection actually served reads. Usage findings need the
  // collection to have been doing something — an idle cluster proves nothing
  // about any index in it (analysis/activity.ts).
  activeHours?: number,
): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  const eligible = indexes.filter((index) => !isNeverDrop(index.spec));
  const redundant = new Set<string>();
  // Usage-based findings need a history we can trust; redundancy is structural
  // and stands on its own.
  const trusted = (index: IndexInput): boolean =>
    usageHistoryIsTrustworthy(index.history, options, now, activeHours);

  for (const candidate of eligible) {
    const covering = indexes.find(
      (other) => other.pendingRemoval !== true && isRedundantPrefix(candidate.spec, other.spec),
    );
    if (covering !== undefined) {
      redundant.add(candidate.spec.name);
      candidates.push({
        type: "DROP_REDUNDANT",
        indexName: candidate.spec.name,
        usageClass: null,
        rationale: servedByBackwardWalk(candidate.spec, covering.spec)
          ? `Key-prefix of ${covering.spec.name} with every direction reversed, which the ` +
            `server serves by reading that index backwards — so it already covers this one.`
          : `Key-prefix of ${covering.spec.name}, which already covers it.`,
        score: dropScore({
          usageClass: null,
          snapshots: totalObservations(candidate.history),
          redundant: true,
          sizeBytes: sizes[candidate.spec.name] ?? 0,
          regressionWeight: regressionWeights[candidate.spec.name] ?? 0,
        }),
        estimatedBytesSaved: sizes[candidate.spec.name] ?? 0,
      });
    }
  }

  for (const index of eligible) {
    if (redundant.has(index.spec.name)) continue;
    // A hole in the series (cluster unreachable, collector down) makes a busy
    // index look exactly like a dead one — say nothing rather than guess.
    if (!trusted(index)) continue;
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
      score: dropScore({
        usageClass,
        snapshots: totalObservations(index.history),
        redundant: false,
        sizeBytes: sizes[index.spec.name] ?? 0,
        regressionWeight: regressionWeights[index.spec.name] ?? 0,
      }),
      estimatedBytesSaved: sizes[index.spec.name] ?? 0,
    });
  }

  // Advisory tier: protected indexes (unique/TTL/shard/partial/sparse) are never
  // auto-dropped, but one that also shows zero usage deserves a human look
  // instead of staying silent. _id_ is exempt — it is never optional.
  const advised = new Set<string>();
  for (const index of indexes) {
    if (!isNeverDrop(index.spec) || index.spec.name === "_id_") continue;
    if (!trusted(index)) continue;
    const usageClass = classifyUsage(index.history, options);
    if (usageClass !== "FLAT_ZERO" && usageClass !== "PERIODIC_DEAD") continue;
    advised.add(index.spec.name);
    candidates.push({
      type: "ADVISORY_REVIEW",
      indexName: index.spec.name,
      usageClass,
      rationale:
        "Protected index (unique/TTL/shard/partial/sparse) with no recorded usage — never auto-dropped; review manually.",
      score: dropScore({
        usageClass,
        snapshots: totalObservations(index.history),
        redundant: false,
        sizeBytes: sizes[index.spec.name] ?? 0,
        regressionWeight: regressionWeights[index.spec.name] ?? 0,
      }),
      estimatedBytesSaved: sizes[index.spec.name] ?? 0,
    });
  }

  // A unique index whose keys prefix a wider index stores redundant DATA, but
  // dropping it loses the uniqueness constraint — a call only a human can make,
  // so it is advisory-only (and the engine's drop paths still protect it).
  for (const index of indexes) {
    if (!index.spec.unique || index.spec.name === "_id_" || index.spec.isShardKey) continue;
    if (advised.has(index.spec.name)) continue;
    const wider = indexes.find(
      (other) =>
        other.pendingRemoval !== true &&
        isKeyPrefix(index.spec, other.spec) &&
        // "the index data is redundant" has to be TRUE before a human is asked
        // to act on it, and it is not when this index covers columns the wider
        // one does not carry.
        coversIncludes(index.spec, other.spec),
    );
    if (wider === undefined) continue;
    candidates.push({
      type: "ADVISORY_REVIEW",
      indexName: index.spec.name,
      usageClass: null,
      rationale:
        `Unique index whose keys are a prefix of ${wider.spec.name}` +
        (servedByBackwardWalk(index.spec, wider.spec)
          ? ` (with every direction reversed, which that index serves by being read backwards)`
          : "") +
        ` — the index data is ` +
        `redundant, but dropping it would lose the uniqueness constraint. If the constraint ` +
        `is obsolete, drop it yourself; if not, consider making ${wider.spec.name} unique ` +
        `and dropping this one. Never auto-dropped.`,
      score: dropScore({
        usageClass: null,
        snapshots: totalObservations(index.history),
        redundant: true,
        sizeBytes: sizes[index.spec.name] ?? 0,
        regressionWeight: regressionWeights[index.spec.name] ?? 0,
      }),
      estimatedBytesSaved: sizes[index.spec.name] ?? 0,
    });
  }

  return candidates;
}
