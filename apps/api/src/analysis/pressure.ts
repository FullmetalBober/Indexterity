// Is a collection hurting right now?
//
// The obvious version of this check is CPU and memory, and the engine cannot
// run it: the least-privilege user Indexterity provisions has no serverStatus,
// no hostInfo and no inprog. That is deliberate — the trust story is that it
// sees index metadata and nothing else — and reading host metrics would mean
// asking every customer to widen the role.
//
// It would also be the wrong signal. A loaded CPU says something is busy, not
// that an index is missing: a backup, a batch job, an aggregation, a noisy
// neighbour all look the same. What actually says "a query is scanning" is the
// collection's own read latency climbing while its read count keeps rising —
// and $collStats latencyStats is already a CORE privilege, already collected.
//
// So: compare the average latency per read now against what it was, and treat a
// sharp rise on a collection still serving traffic as a reason to go looking
// for a missing index immediately rather than at the next scheduled pass.

export interface CumulativeReads {
  readonly ops: number;
  readonly latencyMicros: number;
}

// Both counters are cumulative since the server started, so the interval's
// average is the ratio of the differences.
export interface PressureVerdict {
  readonly underPressure: boolean;
  // Average microseconds per read in the interval, and the baseline it is being
  // judged against. Zero when the interval carried no reads.
  readonly currentMicros: number;
  readonly baselineMicros: number;
  readonly reason: string | null;
}

export interface PressureOptions {
  // How much worse than baseline counts as pressure.
  readonly factor: number;
  // Reads in the interval below which the sample is too thin to trust.
  readonly minOps: number;
  // Latency under this is fast enough that a multiple of it is still fast, and
  // ratios on tiny numbers are noise.
  readonly floorMicros: number;
}

export const DEFAULT_PRESSURE: PressureOptions = {
  factor: 3,
  minOps: 20,
  floorMicros: 1000,
};

// `baseline` is the last stored sample, `current` a fresh reading. Both are
// cumulative, so the difference is what happened in between.
export function readPressure(
  baseline: CumulativeReads,
  current: CumulativeReads,
  options: PressureOptions = DEFAULT_PRESSURE,
): PressureVerdict {
  const ops = current.ops - baseline.ops;
  const micros = current.latencyMicros - baseline.latencyMicros;
  const none = { underPressure: false, currentMicros: 0, baselineMicros: 0 };

  // A restarted counter, or a collection nobody touched: nothing to say.
  if (ops < 0 || micros < 0) {
    return { ...none, reason: null };
  }
  if (ops < options.minOps) {
    return { ...none, reason: null };
  }

  const currentMicros = micros / ops;
  // The baseline is the collection's own historical average, which is what the
  // stored sample already represents.
  const baselineMicros = baseline.ops > 0 ? baseline.latencyMicros / baseline.ops : 0;
  if (baselineMicros <= 0) {
    return { underPressure: false, currentMicros, baselineMicros, reason: null };
  }
  if (currentMicros < options.floorMicros) {
    return { underPressure: false, currentMicros, baselineMicros, reason: null };
  }
  if (currentMicros < baselineMicros * options.factor) {
    return { underPressure: false, currentMicros, baselineMicros, reason: null };
  }
  return {
    underPressure: true,
    currentMicros,
    baselineMicros,
    reason:
      `reads averaging ${duration(currentMicros)} against a ${duration(baselineMicros)} ` +
      `baseline across ${ops} reads`,
  };
}

// A fast baseline is the interesting case — "against a 0ms baseline" is what
// 172µs rounds to, and it reads like the measurement failed.
function duration(micros: number): string {
  if (micros >= 10_000) return `${Math.round(micros / 1000)}ms`;
  if (micros >= 1000) return `${(micros / 1000).toFixed(1)}ms`;
  return `${Math.round(micros)}µs`;
}
