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

// A cluster-wide traffic reading. Ops are the cumulative $collStats counters,
// so what a single sample means is only knowable next to its predecessor.
export interface TrafficSample {
  readonly capturedAt: string;
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
// An interval longer than this spans a gap in collection, so its op delta
// covers time we were not watching. Matches the classifier's gap tolerance.
const MAX_INTERVAL_HOURS = 48;

function pad(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// The quietest 6h slot of the day, or null when the evidence does not support
// naming one. Used only when the owner has not set a window themselves.
//
// Deltas, not levels: the counters are cumulative since the server started, so
// each interval's traffic is the difference between consecutive samples. A
// negative delta means the counter restarted, and an over-long interval means
// we stopped watching — both are dropped rather than averaged in.
export function inferChangeWindow(samples: readonly TrafficSample[]): InferredWindow | null {
  const sorted = [...samples]
    .map((sample) => ({ time: new Date(sample.capturedAt).getTime(), ops: sample.ops }))
    .filter((sample) => Number.isFinite(sample.time))
    .sort((a, b) => a.time - b.time);

  const totals = new Array<number>(BUCKETS).fill(0);
  const counts = new Array<number>(BUCKETS).fill(0);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    const delta = current.ops - previous.ops;
    if (delta < 0) continue;
    const spanHours = (current.time - previous.time) / HOUR_MS;
    if (spanHours <= 0 || spanHours > MAX_INTERVAL_HOURS) continue;
    // Attribute the traffic to where the interval started, and normalise to
    // ops per hour so an unevenly timed collect does not distort the average.
    const bucket = Math.floor(new Date(previous.time).getUTCHours() / BUCKET_HOURS);
    const total = totals[bucket];
    const count = counts[bucket];
    if (total === undefined || count === undefined) continue;
    totals[bucket] = total + delta / spanHours;
    counts[bucket] = count + 1;
  }

  const averages: number[] = [];
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const count = counts[bucket];
    const total = totals[bucket];
    if (count === undefined || total === undefined || count < MIN_OBSERVATIONS_PER_BUCKET) {
      return null;
    }
    averages.push(total / count);
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
