import { MAX_GAP_HOURS } from "./classify";
import { type Run, sortedRuns, spanEnd, spanStart } from "./types";

// Change-window policy: elective index changes (hide, build, drop) run only
// inside the configured UTC hour window. Safety responses (unhide, regression
// rollback) are never deferred — they run whenever the engine notices.
//
// Null bounds or start === end mean "no window" (always allowed); start > end
// wraps midnight (22 -> 4 = ten pm to four am).
export function inChangeWindow(
  now: Date,
  startHour: number | null,
  endHour: number | null,
): boolean {
  if (startHour === null || endHour === null || startHour === endHour) return true;
  const hour = now.getUTCHours();
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

// A traffic reading for ONE namespace. Ops are the cumulative $collStats
// counters, so what a single sample means is only knowable next to its
// predecessor — and, since a reading covers [capturedAt, lastSeenAt], next to
// the gap between them.
export interface TrafficSample extends Run {
  readonly ops: number;
}

export interface InferredWindow {
  readonly startHour: number;
  readonly endHour: number;
  // Why this window, for the dashboard and the audit trail.
  readonly reason: string;
}

// Collect runs every 6h, so the finest slot the evidence supports is a quarter
// of the day. Four buckets: 00-06, 06-12, 12-18, 18-00 UTC.
const BUCKET_HOURS = 6;
const BUCKETS = 24 / BUCKET_HOURS;
// Each bucket needs this many clean intervals before its average means
// anything — roughly three days of collects.
const MIN_OBSERVATIONS_PER_BUCKET = 3;
// A quiet period has to be genuinely quiet. Below this the day is flat and
// picking a "best" hour would be dressing up noise as a decision.
const QUIET_RATIO = 0.75;
const HOUR_MS = 3_600_000;
// An interval longer than this spans a gap in collection, so its op delta covers
// time we were not watching. The classifier's own tolerance, imported rather than
// restated: "we stopped watching" has to mean the same thing to every reader of
// the series and to the collector that writes it.
const MAX_INTERVAL_HOURS = MAX_GAP_HOURS;
// A run is bounded only by retention, so the bucket walk below is bounded here
// rather than by the data: four slots a day for a bit over a year, which is the
// longest history any plan keeps.
const MAX_BUCKET_STEPS = BUCKETS * 400;

function pad(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// What one namespace contributes to one slot of the day: ops, the hours they were
// spread over, and how much separate evidence the slot has.
interface Slot {
  ops: number;
  hours: number;
  intervals: number;
}

type BucketTally = Slot[];

function emptyTally(): BucketTally {
  return Array.from({ length: BUCKETS }, () => ({ ops: 0, hours: 0, intervals: 0 }));
}

function bucketOf(time: number): number {
  return Math.floor(new Date(time).getUTCHours() / BUCKET_HOURS);
}

// Spread a stretch we watched WITHOUT the counter moving across the slots it
// covers. This is the run-length case, and getting it wrong is the failure the
// issue behind this change called out: crediting a multi-day run to the single
// slot it began in leaves the other three starved of evidence, and a cluster
// that is busy by day and dead by night — the one with the clearest window in
// the world — would come back "not enough history to say".
//
// A zero delta across a run is stronger evidence than a point sample, not
// weaker: total traffic over the whole span was zero, so traffic in every
// sub-interval of it was zero too. Each 6h window the run touches therefore
// earns its covered hours AND a mark of coverage, whatever time of day we
// happened to be looking.
function creditQuietRun(tally: BucketTally, from: number, to: number): void {
  let cursor = from;
  for (let step = 0; step < MAX_BUCKET_STEPS && cursor < to; step++) {
    const bucket = bucketOf(cursor);
    // The end of the 6h window `cursor` sits in.
    const boundary = new Date(cursor);
    boundary.setUTCHours((bucket + 1) * BUCKET_HOURS, 0, 0, 0);
    const until = Math.min(to, boundary.getTime());
    const slot = tally[bucket];
    if (slot === undefined) return;
    slot.hours += (until - cursor) / HOUR_MS;
    slot.intervals += 1;
    cursor = until;
  }
}

// One namespace's runs, tallied per slot of the day.
function tallyNamespace(samples: readonly TrafficSample[]): BucketTally {
  const sorted = sortedRuns(samples);
  const tally = emptyTally();

  for (const [i, run] of sorted.entries()) {
    // The run itself: time we were watching and the counter held still.
    creditQuietRun(tally, spanStart(run), spanEnd(run));

    // The gap to the next run: the only stretch where the traffic can be.
    const next = sorted[i + 1];
    if (next === undefined) continue;
    const delta = next.ops - run.ops;
    if (delta < 0) continue;
    const from = spanEnd(run);
    const spanHours = (spanStart(next) - from) / HOUR_MS;
    if (spanHours <= 0 || spanHours > MAX_INTERVAL_HOURS) continue;
    // Attribute the traffic to where the interval started. Sound here in a way
    // it would not be for a run, because the writer keeps this gap under the
    // collect cadence's own tolerance — it cannot span more than one slot by
    // enough to matter.
    const slot = tally[bucketOf(from)];
    if (slot === undefined) continue;
    slot.ops += delta;
    slot.hours += spanHours;
    slot.intervals += 1;
  }
  return tally;
}

// The quietest 6h slot of the day, or null when the evidence does not support
// naming one. Used only when the owner has not set a window themselves.
//
// Deltas, not levels: the counters are cumulative since the server started, so
// each interval's traffic is the difference between consecutive samples. A
// negative delta means the counter restarted, and an over-long interval means
// we stopped watching — both are dropped rather than averaged in.
//
// Takes one series PER NAMESPACE rather than one pre-summed cluster series, and
// that is forced by run-length storage rather than chosen. Summing first used to
// work because every row of a collect shared a timestamp, so grouping by it
// recovered the cluster's total at that instant. Runs end where each namespace's
// own traffic changes, so those timestamps no longer line up, and summing across
// them would read a namespace whose run simply had not ended yet as a collection
// that stopped reporting — a cluster-wide total that plunges and recovers on
// every boundary. Each namespace is therefore reduced to a rate on its own
// timeline, and the rates are summed at the end, where they are comparable.
export function inferChangeWindow(
  namespaces: readonly (readonly TrafficSample[])[],
): InferredWindow | null {
  const tallies = namespaces.map(tallyNamespace);

  const averages: number[] = [];
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    let rate = 0;
    // Coverage is a fact about TIME, so it is the best-covered namespace's count
    // and not the sum: with two hundred collections, summing would clear a floor
    // meant to represent three days of collects on the strength of a single one.
    let coverage = 0;
    for (const tally of tallies) {
      const slot = tally[bucket];
      if (slot === undefined) return null;
      if (slot.hours > 0) rate += slot.ops / slot.hours;
      coverage = Math.max(coverage, slot.intervals);
    }
    if (coverage < MIN_OBSERVATIONS_PER_BUCKET) return null;
    averages.push(rate);
  }

  let quietest = 0;
  for (let bucket = 1; bucket < BUCKETS; bucket++) {
    const candidate = averages[bucket];
    const best = averages[quietest];
    if (candidate !== undefined && best !== undefined && candidate < best) quietest = bucket;
  }
  const quiet = averages[quietest];
  const busiest = Math.max(...averages);
  if (quiet === undefined || busiest <= 0) return null;
  if (quiet > busiest * QUIET_RATIO) return null;

  const startHour = quietest * BUCKET_HOURS;
  const endHour = (startHour + BUCKET_HOURS) % 24;
  const share = Math.round((quiet / busiest) * 100);
  return {
    startHour,
    endHour,
    reason:
      `chosen automatically: ${pad(startHour)}–${pad(endHour)} UTC is the quietest ` +
      `six hours of the day, at ${share}% of peak traffic`,
  };
}
