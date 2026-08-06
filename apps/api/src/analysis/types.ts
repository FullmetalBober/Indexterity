export type IndexDirection = 1 | -1 | "2dsphere" | "text" | "hashed";

export interface IndexKey {
  readonly field: string;
  readonly direction: IndexDirection;
}

// Normalized view of a MongoDB index plus the options that affect safety.
// collation = the locale string, or null for the default binary comparison —
// two same-key indexes under different collations serve DIFFERENT queries.
export interface IndexSpec {
  readonly name: string;
  readonly keys: readonly IndexKey[];
  readonly unique: boolean;
  readonly ttl: boolean;
  readonly partial: boolean;
  // The actual partialFilterExpression, not just whether there is one. Two
  // partial indexes are only interchangeable if they filter on the same thing,
  // and a boolean cannot say that. Null for a full index, and for specs
  // persisted before this was captured.
  readonly partialFilter: Readonly<Record<string, unknown>> | null;
  readonly sparse: boolean;
  readonly hidden: boolean;
  readonly isShardKey: boolean;
  readonly collation: string | null;
}

// $indexStats is cumulative and per-member. `since` is when THAT member's
// counter started — it jumps forward when mongod restarts or the index is
// rebuilt, and the ops count begins again at zero. Without it a busy index is
// indistinguishable from a dead one immediately after a restart.
// Optional: snapshots collected before it was persisted simply lack it.
export interface MemberUsage {
  readonly member: string;
  readonly ops: number;
  readonly since?: string;
}

// One reading of a cumulative counter, covering the closed interval
// [capturedAt, lastSeenAt].
//
// The storage layer run-lengths these. An idle index reports byte-identical
// counters every collect, and an idle collection the same four latency totals, so
// one row records the state once and extends its END rather than repeating
// itself — storage becomes a function of how much the cluster CHANGES instead of
// how often we look at it.
//
// Every reader here therefore has to treat a reading as a SPAN and not an
// instant: the state was first seen at `capturedAt`, was still true at
// `lastSeenAt`, and was confirmed `observations` times across that span. What
// happened BETWEEN two readings is the gap `[previous.lastSeenAt, next.capturedAt]`
// — the only stretch we were not looking.
//
// Both fields are optional, and the defaults are exact rather than lenient: one
// observation IS a run of one, so `lastSeenAt ?? capturedAt` and
// `observations ?? 1` describe it precisely. That is what lets a caller holding a
// point reading — a test, an agent shipping a single collect — build one without
// knowing runs exist. Read them through the helpers below so the default lives
// in one place.
export interface Run {
  readonly capturedAt: string;
  readonly lastSeenAt?: string;
  readonly observations?: number;
  // The largest interval between two consecutive observations INSIDE this run, in
  // ms. Zero, or absent, for a run of one — it has no interior.
  //
  // A run asserts the state held throughout its span, and the readers here only
  // inspect the holes BETWEEN runs. That is sound precisely while the collector
  // refuses to extend a run across a hole this file would object to, which made a
  // safety property rest on a constant shared between two modules staying in
  // agreement, with nothing in the data to check it against. This is that check:
  // the gate can ask a run how bad its own interior was rather than assume.
  readonly maxGapMs?: number;
}

// Build a Run from a database row.
//
// The optional fields above are what let a caller holding a point reading write
// `{ capturedAt }` and mean it. The cost is that a DB read site can omit them by
// accident and get a silently plausible point reading — a year-long run collapsing
// to the instant it began, which reads as an ancient snapshot rather than as an
// error. Every read of the two run-length tables goes through here so that the
// mapping is stated once and a new one cannot quietly leave a field out.
export function runFrom(row: {
  capturedAt: Date | string;
  lastSeenAt: Date | string;
  observations: number;
  maxGapMs: number;
}): Required<Run> {
  const iso = (value: Date | string): string =>
    typeof value === "string" ? value : value.toISOString();
  return {
    capturedAt: iso(row.capturedAt),
    lastSeenAt: iso(row.lastSeenAt),
    observations: row.observations,
    maxGapMs: row.maxGapMs,
  };
}

// When the reading was first seen, in ms. NaN for an unparseable stamp, which
// every caller filters on.
export function spanStart(run: Run): number {
  return new Date(run.capturedAt).getTime();
}

// When it was last confirmed still true, in ms. Never earlier than spanStart —
// a `lastSeenAt` behind the start would make a run of negative length, so it is
// treated as the point reading it must have been.
export function spanEnd(run: Run): number {
  const start = spanStart(run);
  if (run.lastSeenAt === undefined) return start;
  const end = new Date(run.lastSeenAt).getTime();
  if (!Number.isFinite(end)) return start;
  return Math.max(start, end);
}

// The widest hole inside a run, in ms. Zero when unknown, which is the honest
// answer for a point reading and for rows written before the column existed: a run
// of one has no interior, and a caller that cannot say has nothing to declare.
export function interiorGap(run: Run): number {
  const gap = run.maxGapMs;
  if (gap === undefined || !Number.isFinite(gap) || gap < 0) return 0;
  return gap;
}

// How many collects saw this state. At least one: a row exists because
// something was observed.
export function observationsOf(run: Run): number {
  const count = run.observations;
  if (count === undefined || !Number.isFinite(count)) return 1;
  return Math.max(1, Math.floor(count));
}

// Total collects behind a series, which is what the thresholds phrased as sample
// COUNTS mean. The row count stopped being the sample count the moment runs
// existed: an index idle for a year is one row and fifteen hundred observations,
// and reading `history.length` there would refuse to call it unused for want of
// evidence it has more of than anything else on the cluster.
export function totalObservations(runs: readonly Run[]): number {
  return runs.reduce((sum, run) => sum + observationsOf(run), 0);
}

// Oldest first, with unparseable stamps dropped. Every reader in this directory
// wants exactly this, and wants it before differencing anything — so the sort key
// and the bad-stamp policy are stated once here rather than at each of them.
export function sortedRuns<T extends Run>(runs: readonly T[]): T[] {
  return [...runs]
    .filter((run) => Number.isFinite(spanStart(run)))
    .sort((a, b) => spanStart(a) - spanStart(b));
}

// Every interval between two consecutive OBSERVATIONS in a series, with the
// number of observations each interval stands for.
//
// This is the one place that knows how a run relates to the collects inside it,
// and it is the load-bearing assumption of run-length storage: a run of n
// observations spanning s ms contributes n-1 intervals of s/(n-1), evenly spaced,
// because the individual stamps are precisely what run-length discarded. Between
// two runs there is one real interval — from the moment a state was last
// confirmed to the moment the next was first seen — and that is the only stretch
// where anything unobserved can have happened.
//
// Reading a run's whole length as a single interval is the mistake available here,
// and it is worth naming because it is wrong in two directions at once: as a
// "gap" it turns a month of diligent watching into an apparent outage, and as an
// "interval between sightings" it turns a steady index into a monthly job.
//
// Takes an ALREADY SORTED series (sortedRuns), so callers that have sorted for
// their own loop do not pay for a second sort.
export function observationGaps(sorted: readonly Run[]): { ms: number; weight: number }[] {
  const gaps: { ms: number; weight: number }[] = [];
  for (const [i, run] of sorted.entries()) {
    const observations = observationsOf(run);
    const span = spanEnd(run) - spanStart(run);
    if (observations > 1 && span > 0) {
      gaps.push({ ms: span / (observations - 1), weight: observations - 1 });
    }
    const next = sorted[i + 1];
    if (next === undefined) continue;
    const between = spanStart(next) - spanEnd(run);
    if (between > 0) gaps.push({ ms: between, weight: 1 });
  }
  return gaps;
}

// The typical interval between two consecutive observations, in ms, taken from
// the data rather than from a configured cadence — the engine is pure and does
// not know what the scheduler is set to, and a cluster's history can span a
// cadence change anyway.
//
// Weighted, because collapsing a hundred quiet collects into one row must not let
// the handful of intervals around them outvote the cadence. Reduces to the plain
// median of consecutive gaps when every run is a point, which is what it was
// before runs existed.
export function medianObservationGap(runs: readonly Run[]): number {
  const gaps = observationGaps(sortedRuns(runs));
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a.ms - b.ms);
  const total = gaps.reduce((sum, gap) => sum + gap.weight, 0);
  let seen = 0;
  for (const [i, gap] of gaps.entries()) {
    seen += gap.weight;
    if (seen * 2 > total) return gap.ms;
    // Landing exactly on the halfway mark is the even-count case: the median is
    // the mean of the two middle values, which is what this was before it
    // learned about weights.
    if (seen * 2 === total) {
      const next = gaps[i + 1];
      return next === undefined ? gap.ms : (gap.ms + next.ms) / 2;
    }
  }
  return gaps[gaps.length - 1]?.ms ?? 0;
}

export interface UsageSnapshot extends Run {
  readonly perMember: readonly MemberUsage[];
}
