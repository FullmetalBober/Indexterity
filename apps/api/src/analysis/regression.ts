export interface LatencySample {
  readonly ops: number;
  readonly latencyMicros: number;
}

export interface RegressionOptions {
  // Windowed average latency must exceed baseline average × factor to count.
  readonly factor: number;
  // Minimum reads during the window before a judgement is meaningful.
  readonly minWindowOps: number;
}

// Three states, because "we cannot tell" must never be spelled the same way as
// "all clear" — the caller acts irreversibly on the difference.
//   REGRESSED    — the window is measurably slower than the baseline.
//   STABLE       — measured, and fine (including: too quiet to have been hurt).
//   UNOBSERVABLE — the baseline no longer relates to the current counters.
export type RegressionVerdict = "REGRESSED" | "STABLE" | "UNOBSERVABLE";

// Compare the average latency since an index was hidden (or built) against the
// baseline captured at that moment. Both samples are cumulative $collStats
// latencyStats readings — cumulative SINCE MONGOD STARTED, which is what makes
// the reset case below possible.
export function evaluateRegression(
  baseline: LatencySample,
  current: LatencySample,
  options: RegressionOptions,
): RegressionVerdict {
  // A counter below its own baseline means the server restarted: the window we
  // believed we were observing is gone, and the arithmetic below would produce
  // a negative "window" that silently reads as no-regression. Refuse instead.
  if (current.ops < baseline.ops || current.latencyMicros < baseline.latencyMicros) {
    return "UNOBSERVABLE";
  }
  const ratio = latencyRatio(baseline, current, options.minWindowOps);
  // Null is "measured, and there is nothing to compare": too quiet to have been
  // hurt, or a baseline with no latency in it at all.
  if (ratio === null) return "STABLE";
  return ratio > options.factor ? "REGRESSED" : "STABLE";
}

// How much slower the window was than the baseline, as a multiple — 1.0 is
// unchanged, 1.5 is half again. Null when the comparison cannot be made.
//
// Extracted from the verdict above rather than written beside it, because the
// cumulative check (#282) needs the NUMBER as well as the verdict: "this
// collection's writes are 52% slower than before the recent run of builds" is
// the whole content of that finding, and a second copy of this arithmetic is a
// second copy that can disagree with the gate acting on it.
//
// Callers must handle the reset case themselves — this returns a ratio from
// whatever it is given, and a current reading below its own baseline is a fact
// about the counters rather than about latency.
export function latencyRatio(
  baseline: LatencySample,
  current: LatencySample,
  minWindowOps: number,
): number | null {
  const windowOps = current.ops - baseline.ops;
  // Too few reads is genuinely fine: if almost nothing read the collection
  // while the index was hidden, hiding it cannot have hurt anyone.
  if (windowOps < minWindowOps) return null;
  const windowAvg = (current.latencyMicros - baseline.latencyMicros) / windowOps;
  const baselineAvg = baseline.ops > 0 ? baseline.latencyMicros / baseline.ops : 0;
  if (baselineAvg <= 0) return null;
  return windowAvg / baselineAvg;
}

// One un-graduated build's write baseline, as the post-build watch stored it.
export interface BuildBaseline {
  readonly builtAt: Date;
  readonly baseline: LatencySample;
}

// The oldest baseline still live for a collection — "before the recent run of
// builds started" (#282).
//
// The post-build watch takes each index's baseline at that index's OWN build
// time, so the second build on a collection is measured against a collection
// already carrying the first, and the third against one carrying both. Every
// comparison is against the immediately preceding state and never against the
// original: three builds that each add a defensible 15% are three STABLE
// verdicts and a collection half again slower than where it started.
//
// No new column and no new table. Every un-graduated build already carries its
// baseline and its `builtAt`, and graduation clears the baselines — so the
// oldest row still holding one IS the reading from before this run of changes,
// and the chain empties itself as the run finishes.
//
// Returns null for an empty set, which is the ordinary case: one build on a
// collection has nothing cumulative to say, and its own watch already said it.
export function oldestLiveBaseline(baselines: readonly BuildBaseline[]): BuildBaseline | null {
  let oldest: BuildBaseline | null = null;
  for (const candidate of baselines) {
    if (oldest === null || candidate.builtAt.getTime() < oldest.builtAt.getTime()) {
      oldest = candidate;
    }
  }
  return oldest;
}
