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

const EMPTY_MEMBERS: readonly MemberUsage[] = [];

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
//
// Exported so the COLLECTOR can compute this at write time (#534). It holds both
// sides already — it loads the run it is about to extend or replace in order to
// fingerprint it — and storing the answer is what frees every reader from
// loading `per_member` for the whole retained window just to difference it.
//
// The rule stays here rather than moving to jobs/: what a counter difference
// MEANS is analysis, and a second copy of it next to the writer is how the
// stored number and the read number drift apart.
export function activityBetween(
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
  let first = true;
  for (const run of sortedRuns(history)) {
    // Stored where the writer left it, differenced here only when it was not
    // (#534). A row written before the columns existed carries neither, and
    // `per_member` is still there to difference — which is what makes the read
    // side's projection a choice rather than a migration deadline.
    //
    // The FIRST run in the window takes `opsTotal`, not `opsDelta`: the stored
    // delta is against the run before it, which this window cannot see, and
    // reading it here would quietly narrow "everything since the member's
    // `since`" into a difference the engine has never acted on. Every later run
    // takes the delta, whose predecessor is inside the window by construction.
    const stored = first ? run.opsTotal : run.opsDelta;
    const ops = stored ?? activityBetween(first ? null : previous, run.perMember ?? EMPTY_MEMBERS);
    first = false;
    previous = new Map((run.perMember ?? EMPTY_MEMBERS).map((member) => [member.member, member]));
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

// The same sum with nothing to difference against — every member's counter read
// in full, negatives clamped.
//
// Not redundant with a stored delta, and this is the whole reason it is stored
// separately: the OLDEST run inside a retention window has no predecessor the
// window can SEE, and `usageSeries` reads it in full on purpose — "the latest
// instant it could have happened, the conservative end, and the only one the
// data supports". A delta against a row the window excludes would be a quieter
// number than the engine has ever acted on, in the direction that costs a drop
// somebody regrets.
export function activityInFull(current: readonly MemberUsage[]): number {
  return current.reduce((total, member) => total + Math.max(0, member.ops), 0);
}

// Did the counters restart between these two readings?
//
// A member whose count went BACKWARDS restarted, whatever its `since` says. A
// member whose `since` moved FORWARD restarted and says so. A member the
// previous reading did not have is skipped rather than treated as a restart —
// an index newly reported by a member that just joined has not reset anything.
//
// Here beside `activityBetween` because it is the same question about the same
// pair, and the collector and the engine must not answer it differently: the
// collector stores this per run (#534) and `analysis/classify.ts` reads the
// stored answer, falling back to this for rows written before the column.
export function countersRestartedBetween(
  previous: ReadonlyMap<string, MemberUsage> | null,
  current: readonly MemberUsage[],
): boolean {
  for (const member of current) {
    const before = previous?.get(member.member);
    if (before === undefined) continue;
    if (member.ops < before.ops) return true;
    const was = before.since === undefined ? null : Date.parse(before.since);
    const now = member.since === undefined ? null : Date.parse(member.since);
    if (was !== null && now !== null && Number.isFinite(was) && Number.isFinite(now) && now > was) {
      return true;
    }
  }
  return false;
}

// The LATEST instant any of these members claims its counter began. An epoch
// cannot testify to anything before its counters started, however long we had
// been watching.
export function latestCounterStart(current: readonly MemberUsage[]): string | null {
  let latest: number | null = null;
  let iso: string | null = null;
  for (const member of current) {
    if (member.since === undefined) continue;
    const at = Date.parse(member.since);
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest) {
      latest = at;
      iso = member.since;
    }
  }
  return iso;
}
