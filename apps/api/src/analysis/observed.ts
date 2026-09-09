import type { LatencyReading } from "./latency";
import { sortedRuns, spanEnd, spanStart } from "./types";

// How much of a hidden index's observe window actually HAPPENED, and whether
// what happened was slower.
//
// The gate this replaces kept its own baseline: one cumulative `$collStats`
// reading taken at hide time, compared at the end against a live one. That
// works exactly until the server restarts, and then it cannot be repaired —
// `latencyRatio`'s denominator is `baseline.latencyMicros / baseline.ops`, the
// collection's LIFETIME average before the hide, and the only record of it was
// the counter the restart zeroed. Re-baselining afterwards compares the hidden
// period against the hidden period, which is worse than not measuring. So the
// old code aborted the whole window and un-hid the index, correctly.
//
// Correct, and on a cluster that restarts nightly it never terminates: a 30-day
// window always contains a restart, so the drop is proposed, hidden, aborted and
// re-proposed forever — hiding an index for a day at a time and converging on
// nothing. That loop is what #392 exposes, since before it the usage gate never
// let such a cluster propose a drop at all.
//
// The way out is to stop keeping a private baseline. `collect` already stores
// every collection's cumulative latency in `latency_samples`, and `latencyPoints`
// already turns consecutive readings into µs/op WINDOW averages that survive a
// restart — the window spanning the reset is null and every other window stands.
// Read from there, both halves of the comparison are restart-proof, and the
// observed time is a measured quantity rather than elapsed wall clock: it is the
// summed length of the windows that produced a reading.
//
// Which is the same move as counter epochs (analysis/classify.ts) one stage
// later. A restart costs the window it lands in, not the observation around it.

const DAY_MS = 86_400_000;

// A restart can only ever cost the drop this much wall clock beyond its window
// before the index is put back. The observation is what is summed, so a cluster
// that is blind half the time takes twice as long to reach the same confidence —
// and past this multiple it is not going to get there, which is a fact worth
// acting on rather than waiting out with somebody's index hidden.
//
// Read by BOTH sides on purpose. jobs/finalize.ts un-hides here, and
// jobs/classify.ts refuses to PROPOSE a drop it can already tell will hit this —
// so a proposal is only made when it can finish, and the two cannot disagree
// about what "can finish" means.
export const OBSERVE_WALLCLOCK_MULTIPLE = 3;

export type ObservedVerdict =
  // Measured, and the collection is slower with the index hidden.
  | "REGRESSED"
  // Measured, and it is not.
  | "STABLE"
  // Not measured enough yet — keep observing.
  | "INCOMPLETE"
  // Nothing to compare against: no usable reading from before the hide. Never
  // spelled the same as STABLE, because the caller drops on the difference.
  | "NO_BASELINE";

export interface ObservedWindow {
  readonly verdict: ObservedVerdict;
  // Summed length of the windows since the hide that produced a µs/op reading.
  readonly observedMs: number;
  // How much slower those windows were than the ones before the hide, as a
  // multiple. Null when either side had nothing drawable.
  readonly ratio: number | null;
}

interface Window {
  readonly startMs: number;
  readonly endMs: number;
  readonly micros: number;
  readonly ops: number;
}

// Which pair of counters to difference. The read side asks whether HIDING an
// index slowed the collection's reads; the write side asks whether BUILDING one
// slowed its writes (jobs/finalize.ts). Same arithmetic over different columns,
// and the write side matters more than a parameter suggests — most collections
// take no writes at all, so "nothing happened" has to read as observation there
// rather than as a window that never filled.
export type LatencyMetric = "read" | "write";

function deltaOf(
  metric: LatencyMetric,
  previous: LatencyReading,
  next: LatencyReading,
): { ops: number; micros: number } {
  return metric === "read"
    ? {
        ops: next.readOps - previous.readOps,
        micros: next.readLatencyMicros - previous.readLatencyMicros,
      }
    : {
        ops: next.writeOps - previous.writeOps,
        micros: next.writeLatencyMicros - previous.writeLatencyMicros,
      };
}

// Consecutive readings, differenced, dropping only the pairs a RESET ate.
//
// A negative delta on a cumulative counter is the whole exclusion. A window with
// no operations in it is not excluded — it is time we watched and during which
// nothing could have been hurt, which is the distinction the observation count
// turns on. Filtering those out here instead made a collection nobody queries
// accumulate no observation at all, so its window never filled and the index was
// eventually un-hidden and re-proposed: the same never-terminating cycle this
// module exists to end, arrived at from the quiet side rather than the restarting
// one. `minWindowOps` belongs to the RATIO, and is applied where that is computed.
function windowsOf(readings: readonly LatencyReading[], metric: LatencyMetric): Window[] {
  const sorted = sortedRuns(readings);
  const windows: Window[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const next = sorted[i];
    if (previous === undefined || next === undefined) continue;
    const { ops, micros } = deltaOf(metric, previous, next);
    if (ops < 0 || micros < 0) continue;
    windows.push({ startMs: spanEnd(previous), endMs: spanStart(next), micros, ops });
  }
  return windows;
}

function totalOps(windows: readonly Window[]): number {
  return windows.reduce((sum, window) => sum + window.ops, 0);
}

function averageMicrosPerOp(windows: readonly Window[]): number | null {
  let micros = 0;
  let ops = 0;
  for (const window of windows) {
    micros += window.micros;
    ops += window.ops;
  }
  return ops > 0 ? micros / ops : null;
}

export interface ObservedOptions {
  // Slower than this multiple of the pre-hide average is a regression. The same
  // number the cumulative gate used, so the threshold does not move with the
  // mechanism.
  readonly factor: number;
  // Reads the window must carry before it says anything. Below it, hiding the
  // index cannot have hurt anyone, so the window measures nothing rather than
  // measuring "fine".
  readonly minWindowOps: number;
  // The µs/op the hide itself recorded, for when retained history holds nothing
  // from before it — the collection was quiet then, or the rows have aged out.
  //
  // Safe here in a way it was not as the old gate's denominator: that compared a
  // post-reset counter against it by SUBTRACTION, which a restart makes
  // meaningless. This is only ever read as a rate, so a later restart cannot
  // touch it. Stored windows are preferred when there are any, since they cover
  // the same length of history as the window being judged.
  readonly recordedBaselineMicrosPerOp?: number | undefined;
}

// `fromMs` is the moment the change landed — when the index was hidden, or when
// it was built. The reference is drawn from the same length of history before it
// as the window being judged, so a collection whose traffic changed shape months
// ago is not compared against what it used to be.
//
// No `now`. Every term is a fold over stored readings, which is the property
// that makes the answer the same on a re-run and lets a test state a history and
// an expected verdict without stubbing a clock. How long ago the last reading
// was is a different question, and `history-stale` upstream already asks it.
export function observedWindow(
  readings: readonly LatencyReading[],
  metric: LatencyMetric,
  fromMs: number,
  observeDays: number,
  options: ObservedOptions,
): ObservedWindow {
  const windows = windowsOf(readings, metric);
  const observeMs = observeDays * DAY_MS;
  const since = windows.filter((window) => window.startMs >= fromMs);
  const before = windows.filter(
    (window) => window.endMs <= fromMs && window.startMs >= fromMs - observeMs,
  );
  const observedMs = since.reduce((sum, window) => sum + (window.endMs - window.startMs), 0);

  // Watch the whole window before drawing any conclusion from it, including the
  // conclusion that it was quiet.
  if (observedMs < observeMs) return { verdict: "INCOMPLETE", observedMs, ratio: null };
  // Too little traffic to have been hurt. Said before the baseline is consulted,
  // and deliberately: a collection nobody queries has no rate on either side, and
  // calling that "no baseline" would refuse the one case where the answer is
  // certain. The old cumulative gate reached the same verdict the same way round,
  // returning a null ratio before it ever divided by the baseline average.
  if (totalOps(since) < options.minWindowOps) return { verdict: "STABLE", observedMs, ratio: null };

  const baseline = averageMicrosPerOp(before) ?? options.recordedBaselineMicrosPerOp ?? null;
  // Traffic on this side of the change and none on the other: there is nothing to
  // compare against, and no amount of further observing creates readings from
  // before it. Never spelled STABLE — the caller acts irreversibly on the
  // difference.
  if (baseline === null || baseline <= 0)
    return { verdict: "NO_BASELINE", observedMs, ratio: null };

  const current = averageMicrosPerOp(since);
  if (current === null) return { verdict: "NO_BASELINE", observedMs, ratio: null };
  const ratio = current / baseline;
  return { verdict: ratio > options.factor ? "REGRESSED" : "STABLE", observedMs, ratio };
}

// Has this drop been hidden longer than the observation is worth?
export function outstayedWindow(hiddenAtMs: number, observeDays: number, nowMs: number): boolean {
  return nowMs - hiddenAtMs > observeDays * OBSERVE_WALLCLOCK_MULTIPLE * DAY_MS;
}

// Would an observe window on this collection finish inside the wall clock the
// cap allows? (jobs/classify.ts, before a drop is ever proposed.)
//
// The duty cycle is what the collection's own recent history measured: the share
// of elapsed time that produced a usable reading. A cluster blind half the time
// needs twice the wall clock to accumulate the same observation, and past the
// cap it will be un-hidden before it gets there — so the honest thing is not to
// hide it at all rather than to start a cycle that cannot end.
export function observationCanFinish(
  readings: readonly LatencyReading[],
  metric: LatencyMetric,
  observeDays: number,
): boolean {
  return observationCanFinishFrom(foldObservation(readings, metric), observeDays);
}

// The FOLD, separated from the rule above (#484).
//
// Two sums and a flag, and every one of them costs O(retained history) to compute
// while the answer is three numbers wide. Postgres can produce them per collection
// over the same window, which is what jobs/latency-evidence.ts does — and the rule
// stays here, once, so a query cannot quietly hold a different opinion about what
// "can finish" means. The multiple is read by finalize.ts too; that was already
// the reason it is a shared constant rather than a literal.
export interface ObservationFold {
  // Was there any reading at all? No history is not a refusal — every other gate
  // on the drop path already asks whether there is enough evidence, and asking it
  // twice in two vocabularies is how the two come to disagree.
  readonly hasHistory: boolean;
  // First reading's start to the last reading's end, in ms.
  readonly elapsedMs: number;
  // Summed length of the windows that produced a usable reading, in ms — the
  // stretches between two consecutive readings whose counters did not go
  // backwards. This is the measured observation, as against elapsed wall clock.
  readonly drawableMs: number;
}

export function foldObservation(
  readings: readonly LatencyReading[],
  metric: LatencyMetric,
): ObservationFold {
  const windows = windowsOf(readings, metric);
  const sorted = sortedRuns(readings);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) {
    return { hasHistory: false, elapsedMs: 0, drawableMs: 0 };
  }
  return {
    hasHistory: true,
    elapsedMs: spanEnd(last) - spanStart(first),
    drawableMs: windows.reduce((sum, window) => sum + (window.endMs - window.startMs), 0),
  };
}

// `observeDays` cancels, and it is worth saying so rather than leaving it to be
// re-derived: the test is
//
//   observeDays / dutyCycle <= observeDays * MULTIPLE
//
// with `dutyCycle = drawable / elapsed`, which for any positive `observeDays`
// reduces to `elapsed <= drawable * MULTIPLE`. It is kept as a parameter because
// the zero case is not the same statement — a zero-day window finishes trivially —
// and because the caller's question is genuinely about its own window.
export function observationCanFinishFrom(fold: ObservationFold, observeDays: number): boolean {
  if (!fold.hasHistory) return true;
  if (fold.elapsedMs <= 0) return true;
  if (fold.drawableMs <= 0) return false;
  return (
    observeDays / (fold.drawableMs / fold.elapsedMs) <= observeDays * OBSERVE_WALLCLOCK_MULTIPLE
  );
}
