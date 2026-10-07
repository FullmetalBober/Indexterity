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
// counterEpochs) — latencyStats carries no counter-start stamp at all, so the
// total having fallen IS the evidence, and the only evidence. Which is also why
// this side cannot segment the way the usage side now does: with no stamp there
// is nothing to date the restart by, so the window spanning it is unmeasurable
// rather than merely short.
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

// A trend from its four readings, which is how the overview's fold hands them
// over (#614): the first and last measurable window of each metric, already
// picked out in postgres. `summarizeLatency` below is the same answer from the
// rows themselves, and the integration suite holds the two to each other.
export function trendFrom(
  samples: number,
  read: { readonly baseline: number | null; readonly current: number | null },
  write: { readonly baseline: number | null; readonly current: number | null },
): LatencyTrend {
  return {
    samples,
    currentReadMicros: read.current,
    baselineReadMicros: read.baseline,
    readDeltaPct: deltaPct(read.baseline, read.current),
    currentWriteMicros: write.current,
    baselineWriteMicros: write.baseline,
    writeDeltaPct: deltaPct(write.baseline, write.current),
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

// The reads on one collection over a window, added up.
export interface ReadsWindow {
  readonly ops: number;
  readonly avgMicros: number;
}

// The reads on a collection either side of a moment — a build (#608).
//
// Every interval between two consecutive readings that lies wholly inside the
// window before `atMs` is added to `before`, and every one wholly inside the
// window after it to `after`. One that straddles the moment belongs to neither:
// part of it ran without the index and part with it. One a counter reset spans
// is skipped by the same test the chart and the trend use (windowAvg), because
// it is unmeasurable here for the same reason.
//
// Ops and latency are summed and divided once, rather than averaging the
// per-interval averages: an hour with one read and an hour with ten thousand
// are not equal evidence.
//
// `afterMs` is how much of the window after has passed, which is the whole of it
// only once the build is a window old.
export function readsAround(
  readings: readonly LatencyReading[],
  atMs: number,
  windowMs: number,
  nowMs: number,
): { before: ReadsWindow | null; after: ReadsWindow | null; afterMs: number } {
  const sorted = sortedRuns(readings);
  let beforeOps = 0;
  let beforeMicros = 0;
  let afterOps = 0;
  let afterMicros = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev === undefined || next === undefined) continue;
    const ops = next.readOps - prev.readOps;
    const micros = next.readLatencyMicros - prev.readLatencyMicros;
    if (windowAvg(micros, ops) === null) continue;
    const from = spanEnd(prev);
    const to = spanStart(next);
    if (from >= atMs - windowMs && to <= atMs) {
      beforeOps += ops;
      beforeMicros += micros;
    } else if (from >= atMs && to <= atMs + windowMs) {
      afterOps += ops;
      afterMicros += micros;
    }
  }
  return {
    before: beforeOps > 0 ? { ops: beforeOps, avgMicros: beforeMicros / beforeOps } : null,
    after: afterOps > 0 ? { ops: afterOps, avgMicros: afterMicros / afterOps } : null,
    afterMs: Math.max(0, Math.min(windowMs, nowMs - atMs)),
  };
}

// What the chart ranking reads of one collection: how many points each chart
// could draw from it, and how many points it has in all, the gaps included.
// Counts rather than the points themselves, so the ranking can run on a fold of
// the rows instead of on the rows (#614): the overview shipped every reading of
// every collection over the window to chart eight of them — 2 MB a load on a
// MongoDB cluster of a hundred collections.
export interface ChartEvidence {
  readonly database: string;
  readonly collection: string;
  readonly readPoints: number;
  readonly writePoints: number;
  readonly points: number;
}

/** A series' chart evidence, counted off its points the way the fold counts rows. */
export function chartEvidence(
  points: readonly LatencyPoint[],
): Pick<ChartEvidence, "readPoints" | "writePoints" | "points"> {
  return {
    readPoints: points.filter((point) => point.readMicros !== null).length,
    writePoints: points.filter((point) => point.writeMicros !== null).length,
    points: points.length,
  };
}

function namespaceOf(evidence: Pick<ChartEvidence, "database" | "collection">): string {
  return `${evidence.database}.${evidence.collection}`;
}

// The collections the two latency charts are sent, ranked ONCE PER METRIC.
//
// #85 came in a third time through this cut. It used to be a single ranking by
// total point count — but every collection on a cluster is read on the same
// cadence, so every one carries the same number of points. Measured on a live
// cluster: 101 collections, all with exactly 77. A sort where every comparison
// returns 0 leaves the input untouched, so the slice took whichever came back
// from postgres first, which there was eight collections nobody writes to.
// Fourteen others had write traffic and none of them made the cut, so the write
// chart drew nothing and said "no write operations recorded over this history" —
// the panel stating the cut's blind spot as a fact about the cluster, which is
// the exact sentence latency-series.ts was written to stop it saying.
//
// Half the budget per metric and union the two, so a collection that is only
// ever written cannot be crowded out by ones that are only ever read. Half,
// rather than the whole cap twice, because the payload #64 measured its way down
// to must not double: the panel draws four series per chart, and half of eight is
// what it can show anyway.
//
// Counted on DRAWABLE points — ones whose metric is non-null — and not on how
// many readings the collection has, which is what let "most evidence" mean
// "collected for longest". Ties break on namespace, so a cluster charts the same
// collections on every load instead of reshuffling with postgres's row order.
function topByMetric<T extends ChartEvidence>(
  evidence: readonly T[],
  drawable: (entry: T) => number,
  limit: number,
): T[] {
  return [...evidence]
    .filter((entry) => drawable(entry) > 0)
    .sort((a, b) => drawable(b) - drawable(a) || namespaceOf(a).localeCompare(namespaceOf(b)))
    .slice(0, limit);
}

// Returns at most `limit` collections for any limit of 2 or more.
//
// The top-up at the end is not padding. A chart with nothing to draw explains
// itself from the `readGap`/`writeGap` of the collections it WAS sent, so a
// cluster on its first collect — where neither metric has a drawable point and
// both rankings come back empty — would ship an empty array and leave the panel
// with nothing to say but "not enough samples yet". That is #85's original
// wording and the whole thing this pair of fields exists to replace.
export function chartableNamespaces<T extends ChartEvidence>(
  evidence: readonly T[],
  limit: number,
): T[] {
  const perMetric = Math.max(1, Math.floor(limit / 2));
  const chosen = new Map<string, T>();
  for (const entry of topByMetric(evidence, (e) => e.readPoints, perMetric)) {
    chosen.set(namespaceOf(entry), entry);
  }
  for (const entry of topByMetric(evidence, (e) => e.writePoints, perMetric)) {
    chosen.set(namespaceOf(entry), entry);
  }
  const byEvidence = [...evidence].sort(
    (a, b) => b.points - a.points || namespaceOf(a).localeCompare(namespaceOf(b)),
  );
  for (const entry of byEvidence) {
    if (chosen.size >= limit) break;
    chosen.set(namespaceOf(entry), entry);
  }
  return [...chosen.values()];
}
