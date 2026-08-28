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

// Consecutive readings, differenced, keeping only the pairs a restart did not
// eat. Same test `windowAvg` applies — a negative delta on a cumulative counter
// is a reset, and a zero-op window measures nothing.
function readWindows(readings: readonly LatencyReading[]): Window[] {
  const sorted = sortedRuns(readings);
  const windows: Window[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const next = sorted[i];
    if (previous === undefined || next === undefined) continue;
    const ops = next.readOps - previous.readOps;
    const micros = next.readLatencyMicros - previous.readLatencyMicros;
    if (ops <= 0 || micros < 0) continue;
    windows.push({ startMs: spanEnd(previous), endMs: spanStart(next), micros, ops });
  }
  return windows;
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

// The pre-hide reference is drawn from the same length of history as the window
// being judged, so a collection whose traffic changed shape months ago is not
// compared against what it used to be.
//
// No `now`. Every term is a fold over stored readings, which is the property
// that makes the answer the same on a re-run and lets a test state a history and
// an expected verdict without stubbing a clock. How long ago the last reading
// was is a different question, and `history-stale` upstream already asks it.
export function observedWindow(
  readings: readonly LatencyReading[],
  hiddenAtMs: number,
  observeDays: number,
  options: ObservedOptions,
): ObservedWindow {
  const windows = readWindows(readings);
  const observeMs = observeDays * DAY_MS;
  const since = windows.filter(
    (window) => window.startMs >= hiddenAtMs && window.ops >= options.minWindowOps,
  );
  const before = windows.filter(
    (window) => window.endMs <= hiddenAtMs && window.startMs >= hiddenAtMs - observeMs,
  );
  const observedMs = since.reduce((sum, window) => sum + (window.endMs - window.startMs), 0);

  const baseline = averageMicrosPerOp(before) ?? options.recordedBaselineMicrosPerOp ?? null;
  // Said before INCOMPLETE, because it does not resolve by waiting: the readings
  // that would have answered it are the ones from before the hide, and no amount
  // of further observing creates them.
  if (baseline === null || baseline <= 0)
    return { verdict: "NO_BASELINE", observedMs, ratio: null };
  if (observedMs < observeMs) return { verdict: "INCOMPLETE", observedMs, ratio: null };

  const current = averageMicrosPerOp(since);
  // Reached the window on the length of its readings but has no rate to show for
  // them. Not reachable through the filters above, and not worth spelling STABLE
  // if it ever becomes so.
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
  observeDays: number,
): boolean {
  const windows = readWindows(readings);
  const sorted = sortedRuns(readings);
  const first = sorted[0];
  const last = sorted.at(-1);
  // No history to judge by. Not a reason to refuse: every other gate on the drop
  // path already asks whether there is enough evidence, and answering that
  // question twice in two vocabularies is how they come to disagree.
  if (first === undefined || last === undefined) return true;
  const elapsed = spanEnd(last) - spanStart(first);
  if (elapsed <= 0) return true;
  const drawable = windows.reduce((sum, window) => sum + (window.endMs - window.startMs), 0);
  if (drawable <= 0) return false;
  return observeDays / (drawable / elapsed) <= observeDays * OBSERVE_WALLCLOCK_MULTIPLE;
}
