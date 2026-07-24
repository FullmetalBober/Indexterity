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

// Detect a read-latency regression during the observe window: compare the
// average read latency since the index was hidden against the pre-hide baseline.
// Both samples are cumulative $collStats latencyStats readings.
export function isRegression(
  baseline: LatencySample,
  current: LatencySample,
  options: RegressionOptions,
): boolean {
  const windowOps = current.ops - baseline.ops;
  if (windowOps < options.minWindowOps) return false;
  const windowAvg = (current.latencyMicros - baseline.latencyMicros) / windowOps;
  const baselineAvg = baseline.ops > 0 ? baseline.latencyMicros / baseline.ops : 0;
  if (baselineAvg <= 0) return false;
  return windowAvg > baselineAvg * options.factor;
}
