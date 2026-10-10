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
import { countersRestartedBetween, latestCounterStart, usageSeries } from "./usage";

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
//
// Stored by the collector where it exists (#534) — it is a fact about a run and
// its predecessor, and computing it here is what made every reader load
// `perMember` for the whole window. Rows written before the column answer the
// old way, from the counters themselves.
function restartedBetween(previous: UsageSnapshot, next: UsageSnapshot): boolean {
  if (next.countersRestarted != null) return next.countersRestarted;
  return countersRestartedBetween(
    new Map((previous.perMember ?? []).map((member) => [member.member, member])),
    next.perMember ?? [],
  );
}

// The latest instant any of this run's counters claims to have started. An epoch
// cannot testify to anything before it, however long we had been watching.
function countersStartedAt(run: UsageSnapshot): number | null {
  const stored = parseTime(run.countersStartedAt ?? undefined);
  if (stored !== null) return stored;
  return parseTime(latestCounterStart(run.perMember ?? []) ?? undefined);
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

// Whole days of trusted watch time behind a usage finding, which is what the row
// carries and what the promotion floor below is compared against. Floored, so a
// span is never rounded up into eligibility it has not earned.
export function trustedWatchDays(history: readonly UsageSnapshot[]): number {
  return Math.floor(trustedWatchMs(history) / (24 * HOUR_MS));
}

// The span a usage finding needs before the engine may act on it UNATTENDED.
//
// Seven days, which is where the single gate above used to sit, and it keeps the
// argument that put it there: a shorter window calls the weekly batch job's index
// dead because it happened not to run yet. What #434 separated is that this is a
// reason to wait before deleting an index, not a reason to say nothing about it —
// so the proposal now appears at CLASSIFY_OPTIONS.minHistoryDays and the
// unattended drop still waits for this.
//
// Read by jobs/apply.ts (promoteByScore) against the evidence span stored on the
// row, and named in the customer sentence analysis/silence.ts composes. A
// hand-approved drop is unaffected: a human clicking Approve on three days of
// evidence is a human deciding, which is the whole distinction.
export const AUTO_APPLY_HISTORY_DAYS = 7;

// Everything the two gates below ask of an index's history, as numbers.
//
// The gates used to walk the run array directly, which is why `classify` had to
// ship every run in the retention window — 183 days on PRO, re-read hourly per
// cluster. Every one of these is a sum, a count, a max or a pass over consecutive
// pairs, so postgres can compute them over the same window and send this instead
// (jobs/usage-evidence.ts).
//
// NOTHING IS TRUNCATED, which is the distinction D96 turns on. The objection
// there is to reading fewer DAYS: a truncated history cannot see a cadence, so a
// monthly job's index reads FLAT_ZERO — droppable, and the most confident verdict
// the engine has — where the full series reads PERIODIC_ALIVE. Folding the whole
// window has no such property. What shrinks is the wire, not the evidence.
//
// The RULES stay here. This is arithmetic; `usageTrustRefusalFrom` and
// `classifyUsageFrom` below decide what it means, so a query reproducing the
// thresholds would be a second copy of them, free to drift. A query that
// reproduces the arithmetic can be cross-checked against `foldUsage` over the
// same rows, which is what usage-evidence.int.test.ts does.
export interface UsageFold {
  /** How many runs there are at all. Zero is `no-history`. */
  readonly runs: number;
  /** Collects, not rows — an index idle for a year is one run and many looks. */
  readonly observations: number;
  /** Looks that saw the counters MOVE. `usageSeries` credits a run exactly one. */
  readonly activeRuns: number;
  /** Summed over counter epochs, so a restart costs its blind window, not the lot. */
  readonly trustedWatchMs: number;
  /** When the newest run was last confirmed. NaN when there are no runs. */
  readonly newestEndMs: number;
  /** When the newest run that moved BEGAN — the instant its burst is dated to. */
  readonly latestActivityMs: number | null;
  /** The worst hole inside any one run. */
  readonly maxInteriorGapMs: number;
  /**
   * Every stretch whose use went unrecorded: from the last reading before a
   * counter restart to the restart itself (#631). Empty where the counters ran
   * through every hole between runs, which a cumulative counter makes harmless.
   */
  readonly blindWindows: readonly BlindWindow[];
}

// From our last reading before a counter restarted to the instant it restarted:
// use in between was counted by a counter that no longer exists, and nobody else
// recorded it.
export interface BlindWindow {
  readonly startMs: number;
  readonly endMs: number;
}

// How long a blind window longer than `maxGapHours` keeps refusing an index's
// usage history (#631): until this many days of history lie after it.
//
// It used to refuse until it left the plan's window — 90, 183 or 365 days by
// plan, which made how long the evidence stayed unusable a matter of what the
// organisation paid. A month because that is the cadence the observe window
// itself is sized for (DEFAULT_OBSERVE_DAYS): a monthly job's index runs at least
// once in the history after the hole, and the whole window — the blind stretch
// included — is still read for its cadence, so nothing D96 warned about is lost.
// A slower job that ran only inside the hole is the residual, and the hide's
// observe window is there for it.
export const BLIND_RECOVERY_DAYS = 30;

// What of the hole between two runs went unrecorded (#631), or null for none.
//
// A hole the counters ran through hides nothing: they are cumulative, so any use
// inside it shows as a difference at the first reading after it. What a hole can
// hide is a counter that STARTED inside it — a restart, a rebuild, a member that
// came back — whose count of the time before its start is gone. So:
//
//   - a counter that started after our last reading: blind from that reading to
//     its start;
//   - a reset with no later start to date it (a counter that went backwards, which
//     is how SQL Server's rebuild shows): blind for the whole hole;
//   - nothing to date the counters by at all: the whole hole, as before #631.
//
// Read off when the counters started, not off the stored restart flag alone. The
// flag is decided by matching each member against the previous reading, and on
// production's MongoDB cluster, whose members restart several times a day and do
// not all answer every collect, it missed every restart across the 22-day outage
// while the counters' start moved from 09-09 to 10-01. The start moved all the
// same.
function blindWindow(previous: UsageSnapshot, next: UsageSnapshot): BlindWindow | null {
  const from = spanEnd(previous);
  const until = spanStart(next);
  if (until <= from) return null;
  const started = countersStartedAt(next);
  if (started !== null && started > from) {
    return { startMs: from, endMs: Math.min(until, started) };
  }
  if (started === null || restartedBetween(previous, next)) return { startMs: from, endMs: until };
  return null;
}

// The reference implementation, and the shape the SQL twin is held to.
//
// `minBlindMs` keeps only blind windows longer than it, which is how the twin
// keeps its answer small: a cluster restarting several times a day leaves a
// short window at each restart, and only long ones can refuse anything.
export function foldUsage(history: readonly UsageSnapshot[], minBlindMs = 0): UsageFold {
  const sorted = sortedRuns(history);
  const series = usageSeries(sorted);
  let maxInteriorGapMs = 0;
  const blindWindows: BlindWindow[] = [];
  for (const [i, run] of sorted.entries()) {
    maxInteriorGapMs = Math.max(maxInteriorGapMs, interiorGap(run));
    const next = sorted[i + 1];
    if (next === undefined) continue;
    const blind = blindWindow(run, next);
    if (blind !== null && blind.endMs - blind.startMs > minBlindMs) blindWindows.push(blind);
  }
  // Read off the SERIES and not the runs, because that is what the gate did: a
  // run that moved contributes one active look and its tail is idle time, and the
  // burst is dated to the run's start rather than to its end.
  let activeRuns = 0;
  let latestActivityMs: number | null = null;
  for (const point of series) {
    if (point.ops <= 0) continue;
    activeRuns += observationsOf(point);
    const at = spanEnd(point);
    if (latestActivityMs === null || at > latestActivityMs) latestActivityMs = at;
  }
  return {
    runs: sorted.length,
    observations: totalObservations(series),
    activeRuns,
    trustedWatchMs: trustedWatchMs(sorted),
    newestEndMs: sorted.length === 0 ? Number.NaN : Math.max(...sorted.map(spanEnd)),
    latestActivityMs,
    maxInteriorGapMs,
    blindWindows,
  };
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
// That argument bounds how long to wait before DELETING an index, and it was
// being used to decide how long to wait before MENTIONING one (#434). The two
// are now separate numbers: this gate is the floor to say anything, and
// AUTO_APPLY_HISTORY_DAYS below is the floor to act without a human.
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
  return usageTrustRefusalFrom(foldUsage(history), options, now, collectionActiveHours);
}

// The same rule over the same numbers, however they were arrived at — walked in
// JS here, or folded in postgres over the identical window. Every threshold and
// every ORDER between them lives here and only here: the refusal kind is what
// metrics count and what the customer sentence names, so two implementations
// that agreed on "untrustworthy" while disagreeing on WHY would be a silent
// divergence in the thing an operator reads.
export function usageTrustRefusalFrom(
  fold: UsageFold,
  options: ClassifyOptions,
  now: Date,
  collectionActiveHours?: number,
): UsageTrustRefusal | null {
  // Collects, not rows. An index idle for a year is a single run, and counting
  // rows here would refuse the very finding the run-length storage exists to
  // make cheap.
  if (fold.observations < options.minHistory) return { kind: "too-few-collects" };
  if (fold.runs === 0) return { kind: "no-history" };
  // The span we actually watched, summed over the counter epochs rather than
  // measured first-to-last. The two are the same number on a cluster that never
  // restarted; where one did, the difference is that a restart now costs the
  // blind window it opened instead of the whole history (see counterEpochs).
  //
  // The staleness check below still reads the newest confirmation, because it
  // asks when we last HEARD from the cluster, which a restart does not change.
  if (fold.trustedWatchMs < options.minHistoryDays * 24 * HOUR_MS) {
    return { kind: "span-too-short" };
  }
  // "This index served none of the reads" is only a claim when there were reads
  // to serve. An idle week proves nothing about any index in it.
  if (collectionActiveHours !== undefined && collectionActiveHours < options.minActiveHours) {
    return { kind: "collection-idle" };
  }
  const maxGap = options.maxGapHours * HOUR_MS;
  // Two kinds of hole, and both have to be checked.
  //
  // INSIDE a run is the one that is easy to miss. A run asserts the state held
  // throughout its span, so it looks by construction hole-free; that assertion is
  // only as good as the collector's refusal to extend across a gap this function
  // would object to. Trusting it meant a safety property rested on MAX_GAP_HOURS
  // meaning the same thing in two modules forever, with nothing in the data to
  // check against — so each run carries its own worst interior gap and is asked
  // rather than believed. Rows written before the column report zero and are
  // trusted exactly as they were.
  //
  // BETWEEN runs, the obvious one: from the moment a state was last confirmed to
  // the moment the next was first seen. Differencing run STARTS instead would
  // read the length of a quiet run as an outage and throw away every idle index —
  // the exact inversion of the bug this guard exists for.
  //
  // And of that hole, only the part a restart left unrecorded (#631). This used
  // to say a restart's blind window needed no check of its own, being inside the
  // hole, so the whole hole was the check. That made every hole blind, counters
  // carried across it or not, and blind for as long as the plan kept history.
  //
  // WHICH KIND is reported when a history has both is the one thing that changed
  // when these became maxima rather than a walk. The walk reported whichever came
  // first in run order; this reports the interior one. Both are true of such a
  // history and the VERDICT is identical either way — the kind is a label on the
  // same refusal, which is why it was not worth carrying two ordinals through the
  // fold to preserve an order nothing had chosen on purpose.
  if (fold.maxInteriorGapMs > maxGap) return { kind: "gap-inside-run" };
  // Between runs, only what a restart left unrecorded (#631) — and only for a
  // month after it. Until then a slow cadence that ran inside it may not have
  // come round again; after it, the history behind the blind stretch speaks for
  // itself. It used to be every hole longer than maxGap, for as long as it stayed
  // in the plan's window: on the hosted deployment, a 22-day outage refused two
  // thirds of a production cluster's indexes until March of the next year,
  // counter carried across it or not.
  const recovered = now.getTime() - BLIND_RECOVERY_DAYS * 24 * HOUR_MS;
  if (fold.blindWindows.some((w) => w.endMs - w.startMs > maxGap && w.endMs > recovered)) {
    return { kind: "gap-between-runs" };
  }
  // And the newest confirmation must itself be recent, or we are reasoning about
  // a cluster we have not seen in a while.
  if (now.getTime() - fold.newestEndMs > maxGap) return { kind: "history-stale" };
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

// The same, over the fold. One function behind both, so a refusal reported to
// metrics and a refusal acted on cannot diverge.
export function usageHistoryIsTrustworthyFrom(
  fold: UsageFold,
  options: ClassifyOptions,
  now: Date,
  collectionActiveHours?: number,
): boolean {
  return usageTrustRefusalFrom(fold, options, now, collectionActiveHours) === null;
}

// Whole days of trusted watch time, off the fold. Floored, so a span is never
// rounded up into eligibility it has not earned.
export function trustedWatchDaysFrom(fold: UsageFold): number {
  return Math.floor(fold.trustedWatchMs / (24 * HOUR_MS));
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
  return classifyUsageFrom(foldUsage(history), options);
}

// The same rule over the fold. Reads ACTIVITY and never the counters (#265):
// `$indexStats.accesses.ops` is cumulative, so "this snapshot has ops" is true of
// every index used even once since the member's `since` — under which
// `activeRuns === observations` held for anything ever used, and CONTINUOUS was
// the verdict on an index that had served nothing for months.
export function classifyUsageFrom(fold: UsageFold, options: ClassifyOptions): UsageClass {
  // Collects on both sides of the comparison below — the fold preserves the count
  // across the split `usageSeries` makes, so the two agree by construction rather
  // than by coincidence.
  if (fold.observations < options.minHistory) return "FLAT_ZERO";
  // Weighted by observation count, not by row count. A run is one row standing
  // for many identical collects, and "was the counter moving every time we
  // looked" is a question about the looks. Counting rows would make a single
  // quiet run outweigh three hundred busy collects it happens to sit beside.
  if (fold.activeRuns === 0) return "FLAT_ZERO";
  if (fold.activeRuns === fold.observations) return "CONTINUOUS";
  // Everything still standing within recentHours of the newest confirmation. A
  // burst is dated to the instant the counter jumped, which is the run's own
  // start, and that is the moment this compares.
  const cutoff = fold.newestEndMs - options.recentHours * HOUR_MS;
  const recentlyActive = fold.latestActivityMs !== null && fold.latestActivityMs >= cutoff;
  return recentlyActive ? "PERIODIC_ALIVE" : "PERIODIC_DEAD";
}
