import { workerEnv } from "../config/env";
import type { Database } from "../db";
import { claimWatermark } from "./watermark";

// How often `classify` may be chased for one cluster (#482, #483).
//
// `collect` chased it on EVERY landed collect, and collect is hourly. So an
// index-usage verdict was re-derived once an hour per cluster from a series that
// had grown by one reading — and re-derived by reading the cluster's whole
// retained window, which made it the largest consumer of network transfer in the
// hosted deployment (5 GB monthly allowance, exhausted against an 82 MB
// database; ~310 MB a day against an allowance of ~165 MB).
//
// The verdict is a claim about WEEKS. The trust gate wants a long series
// precisely so "unused" means something: three days of span, seventy-two hours
// in which the collection actually served reads. One more collect does not move
// an answer built on that, so an hourly re-derivation re-reads the evidence
// rather than changing the conclusion.
//
// TWO THRESHOLDS, because there are two questions and one number cannot answer
// both:
//
//   The collect LEARNED something — a counter moved, an index appeared, a run
//   was broken by a gap. There is new evidence, and how promptly it should
//   change a recommendation is a product decision. Six hours by default.
//
//   The collect learned NOTHING. An idle cluster reports byte-identical counters
//   every time, so its rows are extended rather than inserted (jobs/collect.ts,
//   jobs/runs.ts) — that run-length collapse is the whole point of the storage,
//   and the analysis side went on re-reading the entire window on the next tick
//   regardless.
//
// The second case is the one that looks like it could be skipped outright, and
// cannot. An extension is not nothing: it moves `lastSeenAt` and increments
// `observations`, which is precisely how an index that has been idle since we
// first saw it eventually crosses `minHistoryDays` and `minActiveHours` and
// becomes proposable. A cluster left unclassified until its counters moved would
// never make that crossing, because nothing would have moved. So "no new
// evidence" buys a longer interval, not an indefinite one.

/** The two intervals, as a value rather than a call to `workerEnv`. */
export interface ChaseIntervals {
  // Floor between two chases when the collect inserted at least one row.
  readonly minIntervalMs: number;
  // Ceiling when it inserted none.
  readonly idleIntervalMs: number;
}

export function chaseIntervals(): ChaseIntervals {
  const env = workerEnv();
  return {
    minIntervalMs: env.CLASSIFY_MIN_INTERVAL_MS,
    idleIntervalMs: env.CLASSIFY_IDLE_INTERVAL_MS,
  };
}

// Its own namespace in worker_watermarks, keyed per cluster. Not `passKey`'s
// `pass:` namespace: those keys are the TICK's, one per scheduled pass for the
// whole deployment, read by exact name (jobs/burst.ts). A per-cluster chase is a
// different thing claimed by a different writer, and giving it its own prefix is
// what stops the two ever being confused for one another.
export function chaseKey(pass: string, clusterId: string): string {
  return `chase:${pass}:${clusterId}`;
}

// The instant a previous chase has to predate for this one to be due.
//
// Pure, and the whole of the policy. `claimWatermark` is a compare-and-set
// against this: it succeeds only when the stored stamp is older, so choosing
// which threshold applies is choosing whether the chase happens.
//
// `Math.max` rather than trusting the configuration, because an idle interval
// BELOW the floor would invert the rule it exists to state — an idle cluster
// classifying more often than a busy one. The schema documents that constraint;
// this makes it true regardless.
export function chaseNotBefore(
  now: Date,
  evidenceLanded: boolean,
  intervals: ChaseIntervals,
): Date {
  const elapsed = evidenceLanded
    ? intervals.minIntervalMs
    : Math.max(intervals.minIntervalMs, intervals.idleIntervalMs);
  return new Date(now.getTime() - elapsed);
}

// Whether this collect's `classify` chase should go ahead, claiming the interval
// if so.
//
// A cluster with no stamp at all is due, which is what `claimWatermark`'s insert
// already means: the first collect after a cluster is connected classifies
// immediately rather than waiting six hours to say anything.
//
// The claim is taken WITHOUT being handed back if the enqueue then declines.
// `enqueueClusterPass` declines for exactly one reason — classify is already
// running for this cluster — and a running pass is a pass that is re-deriving
// the verdict right now. Spending the interval on it is correct: the running one
// stands for this tick, which is what the scheduler's own message says. There is
// nothing to defer (see `deferWatermark`, which exists for the case where the
// work provably did not happen).
export async function classifyChaseIsDue(
  db: Database,
  clusterId: string,
  evidenceLanded: boolean,
  intervals: ChaseIntervals = chaseIntervals(),
  now: Date = new Date(),
): Promise<boolean> {
  return await claimWatermark(
    db,
    chaseKey("classify", clusterId),
    chaseNotBefore(now, evidenceLanded, intervals),
    now,
  );
}
