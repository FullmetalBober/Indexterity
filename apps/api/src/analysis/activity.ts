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

import { medianObservationGap, type Run, sortedRuns, spanEnd, spanStart } from "./types";

export interface ActivityPoint extends Run {
  // Cumulative reads for the collection, as $collStats reports them.
  readonly readOps: number;
  // How many of those were OURS, cumulative on the same clock.
  //
  // Required rather than optional on purpose. `$collStats` counts this product's
  // own metadata reads against the collection they measure (mongo/self-reads.ts),
  // so a reading that cannot say how much of itself was synthetic cannot be
  // judged — and an optional field defaulting to zero is exactly the reading that
  // says "none of it" without having checked. Zero is the right answer for SQL
  // Server and PostgreSQL, which measure a table without reading it, and it
  // should be written down as an answer rather than reached as a default.
  readonly selfReadOps: number;
}

const HOUR_MS = 3_600_000;

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
//
// Run-length changes where the traffic can be, and it is worth being precise
// about it. A run is a stretch over which the counter did NOT move, so it
// contributes no active time at all, however long it is and however many
// collects confirmed it. All the traffic sits in the gaps BETWEEN runs — from
// the moment a state was last confirmed to the moment the next one was first
// seen. Crediting a run's own length would be the serious error available here:
// a collection idle for a month would report a month of activity, and idleness
// would start funding the drops it is meant to withhold.
//
// OUR OWN READS ARE NOT TRAFFIC, and for two years they were counted as it.
// `$collStats` reports every read the collection served, and the metadata reads
// this product issues to measure a collection are reads of it — measured at a
// floor of exactly 8 an hour on all 102 namespaces of the hosted dev cluster,
// with no namespace ever reading zero. So the counter moved on every interval
// for every MongoDB collection, this function returned the full retained window
// as active time, and `collection-idle` — the refusal above is written to
// produce — could not fire on the engine that writes most of the rows. The
// control group is SQL Server, which reads DMVs rather than tables: 382 idle
// refusals there against zero across 128 MongoDB indexes.
//
// Subtracted rather than floored. A constant would be a number that stops being
// true the next time a pass gains a call, silently and in the drop-happy
// direction; the tally is kept by the code that issues the reads
// (mongo/self-reads.ts) and moves with it.
export function activeHours(points: readonly ActivityPoint[]): number {
  return activeHoursFrom(foldActivity(points));
}

// The FOLD, separated from the rule above (#484).
//
// Everything `activeHours` does divides in two: a sum over consecutive readings,
// and a unit conversion. The sum is the part that costs O(retained history) to
// compute, and it is the part postgres can do — one row per collection instead of
// one per collection per collect, over the same window (jobs/latency-evidence.ts).
//
// The split exists so there is still ONE rule. A SQL query that reproduced
// `activeHours` whole would be a second copy of the threshold arithmetic, free to
// drift from this one with nothing in the data to notice; a query that produces
// `activeMs` is a copy of the arithmetic that has a cross-check available, because
// both sides can be run over the same rows and compared. `latency-evidence.int.test.ts`
// does exactly that.
export interface ActivityFold {
  // Summed active time, in ms, already capped per interval.
  readonly activeMs: number;
  // Whether there was any interval to measure at all. A collection with one
  // reading has no gap between two, so the median cap is undefined and the
  // honest answer is no active time rather than zero-with-confidence.
  readonly measurable: boolean;
}

export function foldActivity(points: readonly ActivityPoint[]): ActivityFold {
  const sorted = sortedRuns(points);
  const cap = medianObservationGap(sorted);
  if (cap === 0) return { activeMs: 0, measurable: false };

  let activeMs = 0;
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    // Ours over the same interval. A NEGATIVE count means the tally restarted —
    // a redeployed worker, a second replica taking the next pass — and an
    // interval nobody can account for is dropped rather than credited, exactly
    // as a mongod counter restart is on the line below. Both refusals cost only
    // active time, and less active time only ever withholds a drop.
    const ours = current.selfReadOps - previous.selfReadOps;
    if (ours < 0) continue;
    const delta = current.readOps - previous.readOps - ours;
    if (delta > 0) activeMs += Math.min(spanStart(current) - spanEnd(previous), cap);
  }
  return { activeMs, measurable: true };
}

export function activeHoursFrom(fold: ActivityFold): number {
  return fold.measurable ? fold.activeMs / HOUR_MS : 0;
}
