// Turning stored counters into the usage series every rule is written against.
//
// `$indexStats.accesses.ops` is CUMULATIVE and is stored raw: it climbs while an
// index is queried and holds perfectly still while it is not. So a single reading
// says only "used at some point since `since`", and the difference between two
// says what happened in between — which is the question the analysis modules are
// actually asking (#263, #265). Both of them read a reading through here rather
// than reaching for `perMember[].ops`, so the conversion is stated once.

import {
  type MemberUsage,
  observationsOf,
  type Run,
  sortedRuns,
  spanEnd,
  type UsageSnapshot,
} from "./types";

export interface UsagePoint extends Run {
  // ACTIVITY across this span — how many operations used the index while it
  // held — and emphatically not the value of the `$indexStats` counter. Every
  // consumer reads `ops > 0` as "was queried during this span", which is only
  // true of a difference, so `usageSeries` below is the only supported way to
  // build one of these from a stored row.
  readonly ops: number;
}

// How much of the index's usage happened BETWEEN two readings.
//
// `$indexStats.accesses.ops` is cumulative: it climbs while the index is queried
// and holds perfectly still while it is not, and it is stored raw. So a single
// reading says only "used at some point since `since`", and the difference
// between two says what happened in between — which is the question every rule
// in this file is actually asking.
//
// A member whose `since` moved was restarted and its counter restarted with it,
// so what it now reports accumulated after that restart and counts in full
// rather than as a difference. A member that appeared counts in full for the
// same reason, and one that vanished contributes nothing.
//
// A counter that went BACKWARDS restarted too, whatever its `since` says, and now
// counts in full on that evidence alone. It used to fall to the `max(0, …)` and
// contribute nothing — which was safe while a reset anywhere refused the whole
// history, and is not now that a reset only segments it: the post-restart usage
// would have been dropped and the index read as idle over a stretch it was
// serving. It is the direction that matters. Counting in full can only ever say
// an index was used more than it was, which costs a drop nobody makes; the
// clamp could only ever say less, which costs a drop somebody regrets. Reachable
// on any engine whose reset carries no `since` to notice it by — SQL Server's
// ALTER INDEX REBUILD, and Mongo rows written before `since` was persisted.
function activityBetween(
  previous: ReadonlyMap<string, MemberUsage> | null,
  current: readonly MemberUsage[],
): number {
  let total = 0;
  for (const member of current) {
    const before = previous?.get(member.member);
    total +=
      before === undefined || before.since !== member.since || member.ops < before.ops
        ? Math.max(0, member.ops)
        : member.ops - before.ops;
  }
  return total;
}

// Stored counter runs, as the activity series the rules below are written for.
//
// The conversion is not just a subtraction, because a run's SPAN is not one
// event. `collect` extends a run for as long as every counter reading stays
// byte-identical (jobs/runs.ts), so a run that begins with a jump is one moment
// of usage followed by however long the counter then sat still — and that tail
// is idle time. Emitting the run whole would date its activity to the end of
// the tail, which is exactly how an index queried once a month came to read as
// one queried continuously: the counter moved on day one and the run reported
// itself busy for the other twenty-nine.
//
// So a run that moved becomes two readings — the activity, at the instant the
// counter jumped, and the silence that followed it — and a run that did not move
// stays one idle reading spanning its whole length. Observation counts are
// preserved across the split, since the thresholds downstream are phrased in
// collects.
//
// The FIRST run has nothing to difference against: its counter covers everything
// since the member's `since`, which may predate the history entirely. It is read
// as activity at its own start, which is the latest instant it could have
// happened — the conservative end, and the only one the data supports.
export function usageSeries(history: readonly UsageSnapshot[]): UsagePoint[] {
  const series: UsagePoint[] = [];
  let previous: ReadonlyMap<string, MemberUsage> | null = null;
  for (const run of sortedRuns(history)) {
    const ops = activityBetween(previous, run.perMember);
    previous = new Map(run.perMember.map((member) => [member.member, member]));
    const observations = observationsOf(run);
    const end = spanEnd(run);
    if (ops === 0) {
      series.push({
        capturedAt: run.capturedAt,
        lastSeenAt: new Date(end).toISOString(),
        observations,
        maxGapMs: run.maxGapMs ?? 0,
        ops: 0,
      });
      continue;
    }
    series.push({
      capturedAt: run.capturedAt,
      lastSeenAt: run.capturedAt,
      observations: 1,
      maxGapMs: 0,
      ops,
    });
    // A run one collect long has no tail to split off. Longer, and the rest of
    // it is the counter holding still — kept inside the run's own span, so the
    // split can never invent a gap that the collector did not leave.
    if (observations > 1) {
      series.push({
        capturedAt: run.capturedAt,
        lastSeenAt: new Date(end).toISOString(),
        observations: observations - 1,
        maxGapMs: run.maxGapMs ?? 0,
        ops: 0,
      });
    }
  }
  return series;
}
