// Was the COLLECTION being used, not just the index?
//
// Every usage rule so far measured wall-clock: enough snapshots, spanning
// enough days, without a hole. That is the wrong clock for a database that is
// up continuously but only worked occasionally — a staging or development
// cluster, or a production one with a nightly batch and quiet days.
//
// An index reads zero for two completely different reasons: nobody needs it, or
// nobody queried the collection at all. Wall-clock cannot tell them apart, and
// a month of an idle cluster looks exactly like a month of proof. The
// collection's own read counter can: an interval where the collection served no
// reads carries no information about which of its indexes earned their keep.
//
// So usage findings are judged on ACTIVE time — the hours in which the
// collection actually did something — rather than on elapsed time.
//
// In HOURS, and that is the point. This counted active *intervals* until Aug
// 2026, which made the threshold that reads it (`minActiveHours`, once
// `minActiveIntervals: 12`) mean "three days of traffic" only because a collect
// interval happened to be six hours. Shorten the cadence and the same number
// silently buys less evidence: at fifteen minutes, twelve intervals is three
// HOURS, and the engine would start calling indexes dead on it — with no code
// change and no test failure. Hours mean the same thing at every cadence.

export interface ActivityPoint {
  readonly capturedAt: string;
  // Cumulative reads for the collection, as $collStats reports them.
  readonly readOps: number;
}

const HOUR_MS = 3_600_000;

// The typical gap between samples, taken from the data rather than from a
// configured cadence — the engine is pure and does not know what the scheduler
// is set to, and a cluster's history can span a cadence change anyway.
function medianGap(times: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const previous = times[i - 1];
    const current = times[i];
    if (previous === undefined || current === undefined) continue;
    gaps.push(current - previous);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const lower = gaps[middle - 1];
  const upper = gaps[middle];
  if (upper === undefined) return 0;
  // Even count: the mean of the two middle gaps. Odd: the middle one.
  return gaps.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper;
}

// Hours in which the collection served at least one read.
//
// Counters are cumulative since the server started, so an interval's traffic is
// the difference between consecutive samples. A negative difference means the
// counter restarted; that interval is unknowable and is dropped rather than
// counted either way.
//
// Each interval is credited at most the median gap. Without that cap a single
// hole — a cluster unreachable for a day, the control plane down for an
// afternoon — would credit its whole length as traffic the moment the counter
// had moved anywhere inside it, and one outage could manufacture the three days
// of evidence a drop needs. What is known about a long interval is that the
// collection was used *somewhere* in it, not that it was used throughout.
export function activeHours(points: readonly ActivityPoint[]): number {
  const sorted = [...points]
    .map((point) => ({ time: new Date(point.capturedAt).getTime(), readOps: point.readOps }))
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);

  const cap = medianGap(sorted.map((point) => point.time));
  if (cap === 0) return 0;

  let activeMs = 0;
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    const delta = current.readOps - previous.readOps;
    if (delta > 0) activeMs += Math.min(current.time - previous.time, cap);
  }
  return activeMs / HOUR_MS;
}
