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

// Did any member's usage counter restart inside this history? The counter
// resets to zero when the server restarts or the index is rebuilt. Three ways
// to notice:
//
//   1. `since` advanced for a member between two snapshots, or
//   2. the newest counters are YOUNGER than the window being judged — i.e.
//      they cannot possibly account for the whole period we are claiming was
//      idle (architecture §6.2), or
//   3. a member's cumulative ops went BACKWARDS between two snapshots. A
//      cumulative counter cannot shrink; one that did restarted, whatever its
//      `since` claims. This is the only trigger that catches SQL Server's
//      ALTER INDEX REBUILD, which zeroes the index's row in
//      sys.dm_db_index_usage_stats without the service restarting (verified on
//      2022 CU24) — and index-rebuild maintenance jobs are routine in MSSQL
//      shops, so without it a busy index reads as dead the week after every
//      rebuild. Mongo's $indexStats moves `since` on its resets, so rule 1
//      already covers it there; this is belt and braces for every engine.
//
// Snapshots collected before `since` was persisted carry none, and are simply
// skipped by rules 1 and 2: no evidence either way, and the irreversible step
// downstream is still guarded by the regression gate. Rule 3 needs no `since`
// at all.
export function countersRestartedDuring(history: readonly UsageSnapshot[]): boolean {
  const sorted = sortedRuns(history);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return false;

  const earliestSince = new Map<string, number>();
  const previousOps = new Map<string, number>();
  for (const snapshot of sorted) {
    for (const member of snapshot.perMember) {
      const before = previousOps.get(member.member);
      if (before !== undefined && member.ops < before) return true;
      previousOps.set(member.member, member.ops);
      const since = parseTime(member.since);
      if (since === null) continue;
      const previous = earliestSince.get(member.member);
      if (previous === undefined) earliestSince.set(member.member, since);
      else if (since > previous) return true;
    }
  }

  // Both ends of the WATCHED period, not of the row list: the newest run may
  // have been extended long past the moment it was first written, and that
  // stretch is precisely the part being claimed as idle. Measuring to
  // `capturedAt` instead would understate the window and let a counter younger
  // than the claim slip through.
  const spanMs = spanEnd(last) - spanStart(first);
  const lastSeen = spanEnd(last);
  for (const member of last.perMember) {
    const since = parseTime(member.since);
    if (since === null) continue;
    if (lastSeen - since < spanMs) return true;
  }
  return false;
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
export function usageHistoryIsTrustworthy(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
  now: Date,
  // How many hours the collection was actually queried in. Omitted by callers
  // with no latency history; the check is then skipped rather than failing
  // closed, since older data has no way to supply it.
  collectionActiveHours?: number,
): boolean {
  if (countersRestartedDuring(history)) return false;
  const runs = sortedRuns(history);
  // Collects, not rows. An index idle for a year is a single run, and counting
  // rows here would refuse the very finding the run-length storage exists to
  // make cheap.
  if (totalObservations(runs) < options.minHistory) return false;
  const first = runs[0];
  const last = runs.at(-1);
  if (first === undefined || last === undefined) return false;
  // The span we actually watched: from the first thing we saw to the last time
  // anything was confirmed.
  if (spanEnd(last) - spanStart(first) < options.minHistoryDays * 24 * HOUR_MS) return false;
  // "This index served none of the reads" is only a claim when there were reads
  // to serve. An idle week proves nothing about any index in it.
  if (collectionActiveHours !== undefined && collectionActiveHours < options.minActiveHours) {
    return false;
  }
  const maxGap = options.maxGapHours * HOUR_MS;
  // Two kinds of hole, and both have to be checked.
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
    if (interiorGap(run) > maxGap) return false;
    const next = runs[i + 1];
    if (next === undefined) continue;
    if (spanStart(next) - spanEnd(run) > maxGap) return false;
  }
  // And the newest confirmation must itself be recent, or we are reasoning about
  // a cluster we have not seen in a while.
  return now.getTime() - spanEnd(last) <= maxGap;
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
