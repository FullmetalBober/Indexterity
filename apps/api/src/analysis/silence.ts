import type { ClassifyOptions, UsageTrustRefusal } from "./classify";

// Why a pass had nothing to say, in the words the customer gets (#277).
//
// The gate this reads from was built for the OPERATOR. #267 made
// `usageTrustRefusal` return which of its eight checks refused, and #274 counts
// those into `indexterity.usage_trust.decisions` labelled by engine and reason —
// which answers "how often does this fire across the fleet", the question that
// was being asked at the time. The customer has no equivalent: an empty
// recommendations panel is indistinguishable from "your indexes are all fine",
// and on a cluster that restarts weekly the reset is always inside the retained
// window, so the condition never clears on its own and nothing ever says so.
//
// Everything here is pure. The counting happens in jobs/classify.ts, where the
// gate is already consulted per index; this decides what the totals MEAN.

// The guards in jobs/watched.ts, as the reasons they are. Each one is correct —
// they exist to stop the engine contradicting itself — but each works by making
// a finding disappear, and a suppressed finding left no trace anywhere: "nothing
// to suggest" and "we suggested it and hid it" rendered identically, so a guard
// that was ever too broad could not be told from a quiet cluster.
export type SuppressionGuard =
  // Parked by a past regression (index_cooldowns).
  | "cooldown"
  // Inside its own post-build watch: the engine put this index there and is
  // still judging it.
  | "watched"
  // Already carries a live recommendation this pass will not sweep.
  | "standing"
  // Hinted, so the automatic drop is withheld and only the advisory surfaces.
  | "hinted"
  // A build the collection's index count kept from being made unattended
  // (#281). The odd one out: nothing was withheld from the customer, only from
  // the engine's own hand — the proposal is on screen with its score reduced and
  // its reason in its rationale.
  | "budget";

export const SUPPRESSION_GUARDS: readonly SuppressionGuard[] = [
  "cooldown",
  "watched",
  "standing",
  "hinted",
  "budget",
];

export type RefusalCounts = Partial<Record<UsageTrustRefusal["kind"], number>>;
export type SuppressionCounts = Partial<Record<SuppressionGuard, number>>;

// One pass's account of its own silence, per cluster.
export interface AnalysisSilence {
  // Indexes the usage gate was asked about — the same eligibility the recommender
  // applies, so a protected index is not in the denominator.
  readonly consideredIndexes: number;
  // ...and how many it trusted. Trusted is the number that matters: if even one
  // index cleared the gate then usage analysis is working, whatever the others
  // refused for.
  readonly trustedIndexes: number;
  readonly refusals: RefusalCounts;
  readonly suppressed: SuppressionCounts;
}

// Which refusal to report when several fired, hardest-to-escape first.
//
// A tie-break rather than a ranking of severity, and it has to be deterministic:
// the alternative is a panel whose reason changes between two passes that
// measured the same thing. Ordered by how long the condition can persist:
// staleness and holes need something about the cluster or the collector to
// change, while the warm-up reasons below them clear by themselves with nothing
// but time.
//
// `counters-reset` used to head this list, as the one reason that could persist
// forever — a cluster restarting oftener than the window can never escape it.
// It is gone rather than reordered: a restart segments the history now instead of
// voiding it (analysis/classify.ts), so what such a cluster reports is
// `span-too-short`, which is true, and which its own trusted watch time grows out
// of. A stored key from before the change is ignored here rather than rendered,
// the same way an unknown suppression guard is.
const REFUSAL_PRECEDENCE: readonly UsageTrustRefusal["kind"][] = [
  "history-stale",
  "gap-inside-run",
  "gap-between-runs",
  "collection-idle",
  "span-too-short",
  "too-few-collects",
  "no-history",
];

// The refusal accounting for the most indexes; ties by the precedence above.
export function dominantRefusal(counts: RefusalCounts): UsageTrustRefusal["kind"] | null {
  let best: UsageTrustRefusal["kind"] | null = null;
  let bestCount = 0;
  for (const kind of REFUSAL_PRECEDENCE) {
    const count = counts[kind] ?? 0;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

// Is usage analysis actually PAUSED, as opposed to partial?
//
// Only when nothing cleared the gate. One trusted index means the machinery
// works and the rest are individually short of history, which is an ordinary
// state on any cluster with a mix of old and new indexes — saying "paused" there
// would be crying wolf, and a panel that cries wolf gets ignored by the time it
// is telling the truth.
export function usageAnalysisPaused(silence: AnalysisSilence): boolean {
  return silence.consideredIndexes > 0 && silence.trustedIndexes === 0;
}

// The sentence, thresholds and all.
//
// Here rather than in the dashboard because the numbers are here: every one of
// these reasons is a threshold in CLASSIFY_OPTIONS, and copy that names "7 days"
// in another package is copy that goes stale the day the threshold moves. Same
// argument as `observeReason`, which is written by the engine that chose the
// window.
//
// Each one ends by saying what is NOT affected, because that is the question the
// panel raises: a customer told "recommendations are paused" reasonably concludes
// the product has stopped. Redundancy is structural and never touched the usage
// history — the gate's own comment says so — so those findings keep coming.
export function explainRefusal(
  kind: UsageTrustRefusal["kind"],
  options: Pick<
    ClassifyOptions,
    "minHistory" | "minHistoryDays" | "minActiveHours" | "maxGapHours"
  >,
): string {
  const unaffected = " Redundancy findings are unaffected.";
  switch (kind) {
    case "history-stale":
      return (
        `We have not heard from this cluster in over ${options.maxGapHours} hours, so its usage ` +
        `history is no longer current enough to call an index unused. This clears on the next ` +
        `collect that reaches it.` +
        unaffected
      );
    case "gap-inside-run":
    case "gap-between-runs":
      return (
        `There is a gap of more than ${options.maxGapHours} hours in this cluster's usage ` +
        `history. During a gap a busy index is indistinguishable from a dead one, so the ` +
        `period is not counted as observation. This clears as uninterrupted history accumulates.` +
        unaffected
      );
    case "collection-idle":
      return (
        `These collections have not served reads for ${options.minActiveHours} hours yet. ` +
        `"This index served none of the reads" is only a claim when there were reads to serve, ` +
        `so an idle stretch proves nothing about any index in it.` +
        unaffected
      );
    case "span-too-short":
      return (
        `We have been watching this cluster for less than ${options.minHistoryDays} days. That ` +
        `is the warm-up, not a fault: a shorter window would call the weekly batch job's index ` +
        `dead because it happened not to run yet. Usage findings begin once it passes. A ` +
        `restart does not reset that clock — the counters it zeroed are read as a fresh ` +
        `stretch and the time already watched still counts — but the minutes between our last ` +
        `reading and the restart are nobody's observation, so a cluster that restarts often ` +
        `reaches the threshold more slowly than one that does not.` +
        unaffected
      );
    case "too-few-collects":
      return (
        `Fewer than ${options.minHistory} collects have landed for this cluster. Usage is read ` +
        `as the change between readings, so it takes a few before there is a pattern to read.` +
        unaffected
      );
    case "no-history":
      return `Nothing has been collected from this cluster yet.${unaffected}`;
  }
}

// What a suppressed finding was suppressed BY, in one line each. Counts only —
// which is enough for the thing this is for: a guard that has quietly become too
// broad shows up as a number nobody can explain, where before it showed up as
// nothing at all.
export function explainSuppression(guard: SuppressionGuard, findings: number): string {
  const count = findings === 1 ? "1 finding" : `${findings} findings`;
  switch (guard) {
    case "cooldown":
      return `${count} held back: the index is parked after a previous change regressed reads.`;
    case "watched":
      return `${count} held back: the engine built that index and is still watching it.`;
    case "standing":
      return `${count} held back: that index already carries a recommendation.`;
    case "hinted":
      return `${count} held back from automatic action: a query pins that index by name.`;
    case "budget":
      return (
        `${count} held back from automatic action: the collection is already absorbing builds, ` +
        `and every write to it updates every index on it. Still proposed — approve when you are ` +
        `ready.`
      );
  }
}
