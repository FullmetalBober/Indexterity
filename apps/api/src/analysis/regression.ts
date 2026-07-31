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
  const windowOps = current.ops - baseline.ops;
  // Too few reads is genuinely fine: if almost nothing read the collection
  // while the index was hidden, hiding it cannot have hurt anyone.
  if (windowOps < options.minWindowOps) return "STABLE";
  const windowAvg = (current.latencyMicros - baseline.latencyMicros) / windowOps;
  const baselineAvg = baseline.ops > 0 ? baseline.latencyMicros / baseline.ops : 0;
  if (baselineAvg <= 0) return "STABLE";
  return windowAvg > baselineAvg * options.factor ? "REGRESSED" : "STABLE";
}
