import type { UsageClass } from "@repo/contracts";
import {
  interiorGap,
  observationsOf,
  sortedRuns,
  spanEnd,
  spanStart,
  totalObservations,
  type UsageSnapshot,
} from "./types";
import { usageSeries } from "./usage";

export interface ClassifyOptions {
  // How far back "recent" reaches when deciding alive vs dead, in hours.
  //
  // Was a count of trailing snapshots, which made it another threshold that only
  // meant what it said at the 6h cadence — and the more dangerous of the two,
  // because this is the line between PERIODIC_ALIVE and PERIODIC_DEAD and
  // PERIODIC_DEAD is droppable. Three trailing snapshots is twelve hours at six
  // hours apart and forty-five minutes at fifteen; a nightly job that had simply
  // not run yet today would have read as decommissioned.
  readonly recentHours: number;
  // Minimum snapshots required before attempting periodic classification.
  readonly minHistory: number;
  // Minimum span the history must cover before absence of usage counts as
  // evidence. Snapshot count alone is not enough: three collects is eighteen
  // hours at the 6h cadence, and plenty of real work runs less often than that.
  readonly minHistoryDays: number;
  // Minimum HOURS in which the COLLECTION actually served reads. Elapsed time is
  // the wrong clock for a cluster that is up continuously but only worked
  // occasionally — see analysis/activity.ts, which also explains why this is
  // hours and not the interval count it used to be.
  readonly minActiveHours: number;
  // Largest acceptable hole between consecutive snapshots. A longer one means
  // we stopped watching (cluster unreachable, control plane down), so the
  // history cannot prove absence of usage.
  readonly maxGapHours: number;
}

const HOUR_MS = 3_600_000;

// The gap tolerance, in hours, as a value the WRITER can also see.
//
// It is shared because run-length storage puts the two halves of one invariant in
// different files. A run says "still true throughout [capturedAt, lastSeenAt]", so
// a writer free to extend across a week of silence would hide the hole inside a row
// and the gate below would find a clean series where there was an outage. The
// writer therefore refuses to extend across anything longer than this.
//
// That refusal is now a first line rather than the only one. Each run also records
// its own worst interior gap (`Run.maxGapMs`) and the gate checks it, so the
// property holds even if these two halves drift apart — which is the point, since
// "two modules agree about a constant forever" is not something the data could
// confirm and a safety property should not need faith.
//
// Two days spans a missed collect or two at the 6h cadence without tolerating an
// outage.
export const MAX_GAP_HOURS = 48;
export const MAX_GAP_MS = MAX_GAP_HOURS * HOUR_MS;

function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

// A stretch of history the counters can speak for continuously.
//
// `$indexStats.accesses.ops` resets to zero when the server restarts or the index
// is rebuilt, and the three ways to notice are unchanged:
//
//   1. `since` advanced for a member between two snapshots, or
//   2. a member's cumulative ops went BACKWARDS. A cumulative counter cannot
//      shrink; one that did restarted, whatever its `since` claims. This is the
//      only one that catches SQL Server's ALTER INDEX REBUILD, which zeroes the
//      index's row in sys.dm_db_index_usage_stats without the service restarting
//      (verified on 2022 CU24) — and rebuild maintenance jobs are routine in MSSQL
//      shops, so without it a busy index reads as dead the week after every one.
//      Mongo's $indexStats moves `since` on its resets, so rule 1 already covers it
//      there; this is belt and braces for every engine.
//   3. a member appearing or vanishing, which usage.ts already counts in full.
//
// What CHANGED is what a reset costs. It used to refuse the whole history: one
// restart anywhere inside the window and every index on the cluster was
// unanalysable. That is right for a counter read as a level and wrong for one read
// as a difference, which is what #265 made these — and this file's own note said
// so, that a reset is something "we can reason around", while the gate below went
// on refusing anyway. Measured on a cluster restarting nightly: three epochs of
// 39.2, 24.0 and 11.7 hours, separated by blind windows of 56 and 43 minutes. The
// gate discarded 74.9 hours of good observation to avoid 1.6 hours of blindness,
// and — because the restarts never stop — would have gone on discarding it
// forever, which is the property that makes it a bug rather than a conservative
// choice.
//
// So a reset SEGMENTS the history instead of voiding it. Inside an epoch the
// counter is monotone and every difference is valid; across the boundary sits a
// blind window, from the last reading we took to the instant the counter restarted,
// whose usage nobody recorded. That window is a hole in the observation and is
// judged as one — see the gap checks in usageTrustRefusal, which already bound it.
//
// ANY member resetting ends the epoch for all of them. On a replica set where one
// member bounced and two kept counting that is stricter than the evidence requires;
// it is also the semantics the previous rule had, and widening the claim is not
// something to do in the same change that loosens the gate.
export interface CounterEpoch {
  // First and last instant this epoch's counters were confirmed, in ms.
  readonly startMs: number;
  readonly endMs: number;
}

// Did this run's counters restart relative to the one before it?
function restartedBetween(previous: UsageSnapshot, next: UsageSnapshot): boolean {
  const before = new Map(previous.perMember.map((member) => [member.member, member]));
  for (const member of next.perMember) {
    const prior = before.get(member.member);
    if (prior === undefined) continue;
    if (member.ops < prior.ops) return true;
    const was = parseTime(prior.since);
    const now = parseTime(member.since);
    if (was !== null && now !== null && now > was) return true;
  }
  return false;
}

// The latest instant any of this run's counters claims to have started. An epoch
// cannot testify to anything before it, however long we had been watching.
function countersStartedAt(run: UsageSnapshot): number | null {
  let latest: number | null = null;
  for (const member of run.perMember) {
    const since = parseTime(member.since);
    if (since !== null && (latest === null || since > latest)) latest = since;
  }
  return latest;
}

export function counterEpochs(history: readonly UsageSnapshot[]): CounterEpoch[] {
  const sorted = sortedRuns(history);
  const epochs: CounterEpoch[] = [];
  let first: UsageSnapshot | null = null;
  let end = 0;
  // An epoch begins where we started reading it OR where its counters started,
  // whichever is LATER, and cannot run past its own end.
  //
  // The clamp is the whole of the old `counters-younger-than-span` rule, kept
  // rather than dropped with the veto around it. A boundary is only visible
  // between two snapshots, so the first epoch has none to be found by: a cluster
  // whose first collect landed after a restart looks unbroken, and dating it from
  // that collect would credit us with watching a counter that did not exist yet.
  // It bites there and nowhere else — after a restart we can SEE, `since` is the
  // restart instant and that is before the first reading taken after it.
  const close = (from: UsageSnapshot, to: number): void => {
    const started = countersStartedAt(from);
    const begins = started === null ? spanStart(from) : Math.max(spanStart(from), started);
    epochs.push({ startMs: Math.min(begins, to), endMs: to });
  };
  for (const [i, run] of sorted.entries()) {
    const previous = sorted[i - 1];
    if (first === null) first = run;
    else if (previous !== undefined && restartedBetween(previous, run)) {
      close(first, end);
      first = run;
    }
    end = spanEnd(run);
  }
  if (first !== null) close(first, end);
  return epochs;
}

// How long the counters could actually be read continuously, summed over the
// epochs. Equals the plain first-to-last span on a cluster that never restarted,
// which is every cluster the old measure was right about.
export function trustedWatchMs(history: readonly UsageSnapshot[]): number {
  return counterEpochs(history).reduce((sum, epoch) => sum + (epoch.endMs - epoch.startMs), 0);
}

// Is this history good enough to claim an index is UNUSED? Absence of evidence
// only counts when we were actually watching: too few snapshots, too short a
// span, a hole in the series, or counters that restarted underneath us, and a
// busy index looks identical to a dead one. Structural findings (redundancy) do
// not depend on this.
//
// The span requirement is the warm-up. A freshly connected cluster reaches
// three snapshots in eighteen hours, at which point every index that has not
// happened to run in those eighteen hours reads as dead — including the weekly
// batch and the quarterly export. Counting snapshots measures how often we
// looked; only the span measures how long we watched.
//
// Returns WHICH check refused rather than a bare no (#267). The gate has seven
// of them and they are not equally strict — two are about holes we did not watch
// through, the rest are about there not being enough history yet. "Findings are
// being suppressed" is not actionable until you know which, and the reason is
// free here and unrecoverable later.
export type UsageTrustRefusal =
  | { kind: "no-history" }
  | { kind: "too-few-collects" }
  | { kind: "span-too-short" }
  | { kind: "collection-idle" }
  | { kind: "gap-inside-run" }
  | { kind: "gap-between-runs" }
  | { kind: "history-stale" };

export function usageTrustRefusal(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
  now: Date,
  // How many hours the collection was actually queried in. Omitted by callers
  // with no latency history; the check is then skipped rather than failing
  // closed, since older data has no way to supply it.
  collectionActiveHours?: number,
): UsageTrustRefusal | null {
  const runs = sortedRuns(history);
  // Collects, not rows. An index idle for a year is a single run, and counting
  // rows here would refuse the very finding the run-length storage exists to
  // make cheap.
  if (totalObservations(runs) < options.minHistory) return { kind: "too-few-collects" };
  const first = runs[0];
  const last = runs.at(-1);
  if (first === undefined || last === undefined) return { kind: "no-history" };
  // The span we actually watched, summed over the counter epochs rather than
  // measured first-to-last. The two are the same number on a cluster that never
  // restarted; where one did, the difference is that a restart now costs the
  // blind window it opened instead of the whole history (see counterEpochs).
  //
  // `first` and `last` are still the ones the staleness and gap checks below
  // read, because those ask when we last HEARD from the cluster, which a restart
  // does not change.
  if (trustedWatchMs(runs) < options.minHistoryDays * 24 * HOUR_MS) {
    return { kind: "span-too-short" };
  }
  // "This index served none of the reads" is only a claim when there were reads
  // to serve. An idle week proves nothing about any index in it.
  if (collectionActiveHours !== undefined && collectionActiveHours < options.minActiveHours) {
    return { kind: "collection-idle" };
  }
  const maxGap = options.maxGapHours * HOUR_MS;
  // Two kinds of hole, and both have to be checked. A restart's blind window is
  // a third name for the first kind and needs no check of its own: it runs from
  // our last reading to the instant the counter restarted, which is a
  // sub-interval of the gap to the next run, so anything long enough to matter
  // trips `gap-between-runs` first.
  //
  // BETWEEN runs, the obvious one: from the moment a state was last confirmed to
  // the moment the next was first seen. Differencing run STARTS instead would read
  // the length of a quiet run as an outage and throw away every idle index — the
  // exact inversion of the bug this guard exists for.
  //
  // And INSIDE a run, which is the one that is easy to miss. A run asserts the
  // state held throughout its span, so it looks by construction hole-free; that
  // assertion is only as good as the collector's refusal to extend across a gap
  // this function would object to. Trusting it meant a safety property rested on
  // MAX_GAP_HOURS meaning the same thing in two modules forever, with nothing in
  // the data to check against — so each run now carries its own worst interior gap
  // and is asked rather than believed. Rows written before the column existed
  // report zero and are trusted exactly as they were.
  for (const [i, run] of runs.entries()) {
    if (interiorGap(run) > maxGap) return { kind: "gap-inside-run" };
    const next = runs[i + 1];
    if (next === undefined) continue;
    if (spanStart(next) - spanEnd(run) > maxGap) return { kind: "gap-between-runs" };
  }
  // And the newest confirmation must itself be recent, or we are reasoning about
  // a cluster we have not seen in a while.
  if (now.getTime() - spanEnd(last) > maxGap) return { kind: "history-stale" };
  return null;
}

// The boolean every finding is gated on, over the answer above — one function,
// so a refusal reported to metrics and a refusal acted on cannot diverge.
export function usageHistoryIsTrustworthy(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
  now: Date,
  collectionActiveHours?: number,
): boolean {
  return usageTrustRefusal(history, options, now, collectionActiveHours) === null;
}

// Classify an index from its usage history. Pure; no I/O.
// PERIODIC_DEAD vs PERIODIC_ALIVE hinges on whether recent expected bursts
// still appear — a decommissioned monthly job goes dead and becomes droppable.
//
// Reads ACTIVITY, through usageSeries, and never the counters it is handed
// (#265). `$indexStats.accesses.ops` is cumulative, so "this snapshot has ops"
// is true of every index used even once since the member's `since` — under
// which `activeCount === observations` held for anything ever used, and
// CONTINUOUS was the verdict on an index that had served nothing for months.
// The class that is supposed to say "in constant use" was saying "used, once,
// at some point", and CONTINUOUS is not droppable, so the clearest dead-index
// case was the one that could never be proposed.
//
// The trust gates above still read the raw counters, and must: `since` moving
// and a reading going backwards are facts about the counter, not about usage.
export function classifyUsage(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
): UsageClass {
  // Collects, not rows, on both sides of the comparison below — usageSeries
  // preserves the count across the split it makes, so the two agree by
  // construction rather than by coincidence.
  const series = usageSeries(history);
  const observations = totalObservations(series);
  if (observations < options.minHistory) return "FLAT_ZERO";

  // Weighted by observation count, not by row count. A run is one row standing
  // for many identical collects, and "was the counter moving every time we
  // looked" is a question about the looks. Counting rows would make a single
  // quiet run outweigh three hundred busy collects it happens to sit beside.
  const activeCount = series.reduce(
    (sum, point) => (point.ops > 0 ? sum + observationsOf(point) : sum),
    0,
  );
  if (activeCount === 0) return "FLAT_ZERO";
  if (activeCount === observations) return "CONTINUOUS";

  // Everything still standing within recentHours of the newest confirmation,
  // however many rows that turns out to be. A run counts as recent when its END
  // falls inside the window: that is when the state was last confirmed, and a
  // long run reaching into the window was true inside it. For an activity
  // point that end IS the instant the counter jumped, which is the moment the
  // burst has to be dated to.
  const newest = Math.max(...series.map(spanEnd));
  const cutoff = newest - options.recentHours * HOUR_MS;
  const recentlyActive = series.some((point) => spanEnd(point) >= cutoff && point.ops > 0);
  return recentlyActive ? "PERIODIC_ALIVE" : "PERIODIC_DEAD";
}
