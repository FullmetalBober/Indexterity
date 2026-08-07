import { type Run, sortedRuns, spanEnd, spanStart, totalObservations } from "./types";

export interface LatencyReading extends Run {
  readonly readOps: number;
  readonly readLatencyMicros: number;
  readonly writeOps: number;
  readonly writeLatencyMicros: number;
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
//
// Null when either delta is impossible, and a NEGATIVE micros delta is impossible:
// these are cumulative totals, so they only ever go up while the same mongod is
// running. `$collStats` latencyStats resets to zero when it restarts, and the next
// reading is then smaller than the one before it — differencing the pair yields
// negative latency, which was reported to the customer as a very fast collection.
// Observed in the wild at -6,803 µs/op, on 81 of 98 collections at once, because a
// restart resets every namespace on the cluster together.
//
// There is no `since` to check the way index usage has (see classify.ts's
// countersRestartedDuring) — latencyStats carries no counter-start stamp at all, so
// the total having fallen IS the evidence, and the only evidence.
//
// Null rather than zero or the absolute value: we do not know what the latency was
// across that interval, and the honest shape of not knowing is a gap. Zero would
// read as an infinitely fast collection and an absolute value would invent a
// measurement out of two unrelated counter runs.
//
// Scope, so nobody reads this as more than it is: these two functions feed the
// dashboard only (insights.controller.ts). The regression gate that decides whether
// a hidden index actually gets dropped does not come through here — finalize.ts runs
// its own comparison and already returns UNOBSERVABLE across a restart. So the
// engine knew about resets and the display did not, which is the whole of the bug.
function windowAvg(deltaMicros: number, deltaOps: number): number | null {
  if (deltaOps <= 0) return null;
  if (deltaMicros < 0) return null;
  return deltaMicros / deltaOps;
}

export interface LatencyPoint {
  readonly capturedAt: string;
  readonly readMicros: number | null;
  readonly writeMicros: number | null;
}

// The chartable series behind summarizeLatency: a windowed µs/op average per
// consecutive pair of cumulative readings, stamped with the later reading's time.
//
// A reading that stood for several collects gets a null point at the end of its
// run. There is no µs/op to report across it — no ops went through — and a null
// renders as a gap, which is the honest shape: nothing happened here. Without it
// the series would jump straight over a quiet week and the x-axis would imply the
// collection was busy throughout.
export function latencyPoints(readings: readonly LatencyReading[]): LatencyPoint[] {
  const sorted = sortedRuns(readings);
  const points: LatencyPoint[] = [];
  for (const [i, reading] of sorted.entries()) {
    if (spanEnd(reading) > spanStart(reading)) {
      points.push({
        capturedAt: new Date(spanEnd(reading)).toISOString(),
        readMicros: null,
        writeMicros: null,
      });
    }
    const next = sorted[i + 1];
    if (next === undefined) continue;
    points.push({
      capturedAt: next.capturedAt,
      readMicros: windowAvg(
        next.readLatencyMicros - reading.readLatencyMicros,
        next.readOps - reading.readOps,
      ),
      writeMicros: windowAvg(
        next.writeLatencyMicros - reading.writeLatencyMicros,
        next.writeOps - reading.writeOps,
      ),
    });
  }
  return points;
}

// Why a metric has nothing to draw, when it has nothing to draw.
//
// An empty chart and an unmeasurable one looked identical — both rendered "Not
// enough samples yet" — and that is what let #85 be reported twice: the panel
// was stating the collector's blind spot as a fact about the cluster. These are
// the three shapes a null window can have, and they are read straight back off
// the same conditions windowAvg nulls on, so the two cannot drift apart.
export type LatencyGap =
  // One reading. A window needs two, so this resolves itself on the next collect.
  | "AWAITING_SECOND_COLLECT"
  // Readings exist and the counter never moved between any pair of them.
  | "NO_OPS_RECORDED"
  // A total fell, which cumulative counters cannot do while the same mongod
  // runs. Every window spanning the restart is unmeasurable, not zero.
  | "COUNTERS_RESET";

export interface LatencyGaps {
  readonly read: LatencyGap | null;
  readonly write: LatencyGap | null;
}

function gapFor(
  sorted: readonly LatencyReading[],
  ops: (reading: LatencyReading) => number,
  micros: (reading: LatencyReading) => number,
): LatencyGap | null {
  if (sorted.length < 2) return "AWAITING_SECOND_COLLECT";
  let reset = false;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev === undefined || next === undefined) continue;
    const deltaOps = ops(next) - ops(prev);
    const deltaMicros = micros(next) - micros(prev);
    // The same test windowAvg passes on. One drawable window and there is
    // nothing to explain.
    if (deltaOps > 0 && deltaMicros >= 0) return null;
    if (deltaOps < 0 || deltaMicros < 0) reset = true;
  }
  return reset ? "COUNTERS_RESET" : "NO_OPS_RECORDED";
}

// Null per metric when that metric has at least one drawable window.
export function latencyGaps(readings: readonly LatencyReading[]): LatencyGaps {
  const sorted = sortedRuns(readings);
  return {
    read: gapFor(
      sorted,
      (reading) => reading.readOps,
      (reading) => reading.readLatencyMicros,
    ),
    write: gapFor(
      sorted,
      (reading) => reading.writeOps,
      (reading) => reading.writeLatencyMicros,
    ),
  };
}

function deltaPct(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null || baseline <= 0) return null;
  return ((current - baseline) / baseline) * 100;
}

// Turn a series of cumulative $collStats latencyStats readings into a
// before/after trend. The counters are cumulative, so the average latency during
// an interval is Δmicros / Δops. Negative delta = latency fell = app got faster.
export function summarizeLatency(readings: readonly LatencyReading[]): LatencyTrend {
  const sorted = sortedRuns(readings);
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
    // Collects, not rows. This number is shown to the customer as how much we
    // have watched, and run-length storage would otherwise have it fall as the
    // history got longer.
    samples: totalObservations(sorted),
    currentReadMicros: currentRead,
    baselineReadMicros: baselineRead,
    readDeltaPct: deltaPct(baselineRead, currentRead),
    currentWriteMicros: currentWrite,
    baselineWriteMicros: baselineWrite,
    writeDeltaPct: deltaPct(baselineWrite, currentWrite),
  };
}
