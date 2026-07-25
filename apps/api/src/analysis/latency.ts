export interface LatencyReading {
  readonly readOps: number;
  readonly readLatencyMicros: number;
  readonly writeOps: number;
  readonly writeLatencyMicros: number;
  readonly capturedAt: string; // ISO-8601, sorts lexicographically
}

export interface LatencyTrend {
  readonly samples: number;
  readonly currentReadMicros: number | null;
  readonly baselineReadMicros: number | null;
  readonly readDeltaPct: number | null;
  readonly currentWriteMicros: number | null;
  readonly baselineWriteMicros: number | null;
  readonly writeDeltaPct: number | null;
}

// Average latency per op over the interval between two cumulative readings.
function windowAvg(deltaMicros: number, deltaOps: number): number | null {
  return deltaOps > 0 ? deltaMicros / deltaOps : null;
}

function deltaPct(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null || baseline <= 0) return null;
  return ((current - baseline) / baseline) * 100;
}

// Turn a series of cumulative $collStats latencyStats readings into a
// before/after trend. The counters are cumulative, so the average latency during
// an interval is Δmicros / Δops. Negative delta = latency fell = app got faster.
export function summarizeLatency(readings: readonly LatencyReading[]): LatencyTrend {
  const sorted = [...readings].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const reads: number[] = [];
  const writes: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev === undefined || next === undefined) continue;
    const r = windowAvg(
      next.readLatencyMicros - prev.readLatencyMicros,
      next.readOps - prev.readOps,
    );
    if (r !== null) reads.push(r);
    const w = windowAvg(
      next.writeLatencyMicros - prev.writeLatencyMicros,
      next.writeOps - prev.writeOps,
    );
    if (w !== null) writes.push(w);
  }
  const baselineRead = reads[0] ?? null;
  const currentRead = reads[reads.length - 1] ?? null;
  const baselineWrite = writes[0] ?? null;
  const currentWrite = writes[writes.length - 1] ?? null;
  return {
    samples: sorted.length,
    currentReadMicros: currentRead,
    baselineReadMicros: baselineRead,
    readDeltaPct: deltaPct(baselineRead, currentRead),
    currentWriteMicros: currentWrite,
    baselineWriteMicros: baselineWrite,
    writeDeltaPct: deltaPct(baselineWrite, currentWrite),
  };
}
