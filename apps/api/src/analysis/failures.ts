import type { FailedOpsReading, FailureTally } from "../engine/ports";

// Did hiding this index start breaking its queries?
//
// The observe window's own gate measures LATENCY, and that gate cannot answer
// this question — not imperfectly, but not at all. A query that fails is not
// slow, it is fast: measured on mongod 7.0.39, twenty failing $text queries
// against a hidden text index averaged 159 µs/op where the baseline they were
// compared against was 245 µs/op. So a hide that broke the workload made the
// collection look BETTER, `evaluateRegression` returned STABLE, and the drop
// graduated on the strength of the damage.
//
// The taxonomy rule in analysis/safety.ts closes the case that made this
// catastrophic, and the hint rule in the collector closes another. Both are
// lists of things known in advance. This is the signal for everything else: a
// hidden index pushing a query past `maxTimeMS`, a blocking sort that now
// exceeds the 100 MB limit and fails rather than slows, a hint at the index the
// hint rule did not see in time.
//
// ONE-WAY, and the whole design rests on it. Failures seen are evidence;
// failures unseen are nothing, because every source is optional (the MongoDB
// profiler, SQL Server's Query Store) and PostgreSQL has none at all. A gate
// that demanded this signal would refuse every drop on every cluster that does
// not supply it, which is not caution — it is the product not working. So the
// verdict here can turn a graduation into a rollback and can never do the
// reverse.
//
// And only failures the hide could have caused are evidence at all (#625). The
// collector sorts them: a hint naming the index, which only a hide makes fail;
// the kinds a missing index can cause and ordinary traffic has too; and the rest
// — a duplicate key, a document its validator refuses, a client that hangs up —
// which no index's absence causes and which count against nothing. Before that,
// three failures nobody could name parked a redundant index in production.

export interface FailureSample {
  // Suspect failures — the kinds a missing index can cause — up to the hide. A row
  // hidden before #625 counted every kind here, which can only make it more
  // cautious: a dirty baseline attributes nothing.
  readonly failed: number;
  // How far back the source could see when the sample was taken, epoch ms.
  readonly reachMs: number;
}

// How long failures are recorded before a hide, where Indexterity turned the
// profiler on itself (#596) — and how far back a clean baseline has to REACH for
// suspect failures after the hide to be pinned on it (#625).
//
// The verdict that acts needs a clean BEFORE: nothing failing on the collection,
// then failures once the index is hidden. A profiler turned on at the hide has no
// before at all, and every failure after it would be "nothing to compare
// against" and never acted on — the check running and deciding nothing. So the
// watch starts first and the hide waits for it.
//
// A day, because the before is a claim about the collection's ordinary traffic,
// and ordinary traffic has a daily shape: a nightly job that fails on its own
// would be missed by an hour of baseline and then read as the hide's doing — a
// rollback and a cooldown of a whole observe window for a drop that was fine.
// It costs no time in practice: hides only happen inside the change window, which
// comes round once a day, and the watch starts at the first pass after approval.
//
// The wait alone did not deliver the day (#625). It counts from when the watch
// began, and what can still be read of that day is whatever the profiler's ring
// holds — a capped collection, one per database, which a busy database turns over
// in under an hour. In production a hide that had waited its day read a baseline
// of 54 minutes, and a drop was rolled back on it. So the verdict checks the
// reach, and the wait stays: it is what gives a quiet database its day.
export const FAILURE_BASELINE_MS = 24 * 3_600_000;

// Judgement, not a measurement, and named as one — there is no honest way to
// measure "how many errors mean the hide did it" without the application in
// front of you.
//
// Three rather than one, because a single suspect failure is ordinary: a query
// runs past its maxTimeMS on a busy minute, a report sorts more than it was
// allowed to, and aborting a drop on one of those would make the safest engine
// the one that never finishes anything. Three rather than thirty, because the
// failure mode this exists for is not a rate — a hide that breaks a query breaks
// it every time it runs, so the count is the traffic, and any floor a real
// breakage does not clear instantly is a floor set too high.
//
// Not for a hint at the index: a hidden index refuses every one and a visible one
// serves them, so a single failure is the hide's doing and nothing ordinary.
export const MIN_INTRODUCED_FAILURES = 3;

export type FailureVerdict =
  // The hide is implicated: queries naming the index in a hint failed, which a
  // hidden index refuses and a visible one serves. Needs no baseline and no floor.
  | {
      readonly kind: "INTRODUCED";
      readonly cause: "HINTED";
      readonly failed: number;
      readonly unrelated: FailureTally;
    }
  // The hide is implicated: suspect failures after it, and none in a clean
  // baseline that reached back a day.
  //
  // `baselineMs` is how far back that baseline reached, and it is on the verdict
  // because it is the SCOPE of the claim rather than decoration.
  | {
      readonly kind: "INTRODUCED";
      readonly cause: "SUSPECT";
      readonly failed: number;
      readonly kinds: FailureTally;
      readonly baselineMs: number;
      readonly unrelated: FailureTally;
    }
  // Suspect failures that cannot be attributed to the hide, and why. Reported,
  // never acted on: aborting here would let a collection with its own errors
  // veto every drop on it forever.
  | {
      readonly kind: "INCONCLUSIVE";
      readonly failed: number;
      readonly kinds: FailureTally;
      readonly because: Unattributed;
      readonly unrelated: FailureTally;
    }
  // Nothing the hide could have caused seen since it. Which is NOT "nothing
  // happened" — see reachMs — and `blindSpot` is what the source was set up not
  // to record, which the audit line has to say: a profiler keeping only slow
  // operations sees no failures because a failure is fast, not because there
  // were none.
  | {
      readonly kind: "CLEAN";
      readonly blindSpot: string | null;
      readonly unrelated: FailureTally;
    }
  // No source, so no question was asked — and why, because each cause has its own
  // remedy (#596).
  | { readonly kind: "UNAVAILABLE"; readonly reason: string };

export type Unattributed =
  // Already failing before the hide.
  | { readonly kind: "FAILING_BEFORE"; readonly failed: number }
  // No baseline was taken at the hide.
  | { readonly kind: "NO_BASELINE" }
  // Fewer than MIN_INTRODUCED_FAILURES.
  | { readonly kind: "FEW" }
  // A clean baseline too short to be one: it did not reach back a day (#625).
  | { readonly kind: "SHORT_BASELINE"; readonly baselineMs: number };

export function judgeFailures(
  // Sampled at hide time, over whatever window the source could then see.
  before: FailureSample | null,
  // Read now, counting only what happened at or after the hide.
  after: FailedOpsReading,
  // When the hide happened, so the baseline's reach can be stated as a span.
  hiddenAtMs: number,
): FailureVerdict {
  if (after.kind === "NO_SOURCE") return { kind: "UNAVAILABLE", reason: after.reason };
  const { unrelated } = after;
  if (after.hinted !== null && after.hinted > 0) {
    return { kind: "INTRODUCED", cause: "HINTED", failed: after.hinted, unrelated };
  }
  if (after.suspect === 0) return { kind: "CLEAN", blindSpot: after.blindSpot, unrelated };
  const seen = { failed: after.suspect, kinds: after.suspectKinds, unrelated };
  const unattributed = (because: Unattributed): FailureVerdict => ({
    kind: "INCONCLUSIVE",
    ...seen,
    because,
  });
  if (before === null) return unattributed({ kind: "NO_BASELINE" });
  if (before.failed > 0) return unattributed({ kind: "FAILING_BEFORE", failed: before.failed });
  if (after.suspect < MIN_INTRODUCED_FAILURES) return unattributed({ kind: "FEW" });
  const baselineMs = Math.max(0, hiddenAtMs - before.reachMs);
  if (baselineMs < FAILURE_BASELINE_MS) {
    return unattributed({ kind: "SHORT_BASELINE", baselineMs });
  }
  return { kind: "INTRODUCED", cause: "SUSPECT", ...seen, baselineMs };
}

// The audit line, in the words the action trail keeps. Every verdict says
// something, including the two that change nothing — a gate that ran and found
// nothing must not read the same as a gate that never ran (D19).
export function describeFailures(verdict: FailureVerdict): string {
  switch (verdict.kind) {
    case "INTRODUCED":
      return verdict.cause === "HINTED"
        ? `${counted(verdict.failed, "query", "queries")} naming the index in a hint ` +
            `failed since the hide, which a hidden index refuses${notCounted(verdict.unrelated)}`
        : `${failedOps(verdict.failed)} since the hide${kindsOf(verdict.kinds)}, and none in ` +
            `the ${span(verdict.baselineMs)} of history readable before it${notCounted(verdict.unrelated)}`;
    case "INCONCLUSIVE":
      return `${failedOps(verdict.failed)} since the hide${kindsOf(verdict.kinds)}${unattributedBecause(
        verdict.because,
      )}${notCounted(verdict.unrelated)}`;
    case "CLEAN": {
      const seen =
        verdict.unrelated.length === 0
          ? "no failed operations seen since the hide"
          : "no failed operations a hidden index can cause seen since the hide";
      const blind = verdict.blindSpot === null ? "" : `, but ${verdict.blindSpot}`;
      return `${seen}${blind}${notCounted(verdict.unrelated)}`;
    }
    // "Skipped", because that is what happened: the check is optional and asked
    // nothing. It used to read "could not be read on this cluster", which sounds
    // like an error and named none of the causes.
    case "UNAVAILABLE":
      return `failed-operations check skipped: ${verdict.reason}`;
  }
}

function unattributedBecause(because: Unattributed): string {
  switch (because.kind) {
    case "FAILING_BEFORE":
      return `, but ${because.failed} before it — not attributed`;
    case "NO_BASELINE":
      return ", but nothing to compare against — not attributed";
    case "FEW":
      return `, fewer than the ${MIN_INTRODUCED_FAILURES} it takes to act`;
    case "SHORT_BASELINE":
      return (
        `, but only ${span(because.baselineMs)} of history before it could be read, short of ` +
        "the day it takes to pin them on the hide — not attributed"
      );
  }
}

// The cause in a cooldown's reason, which the dashboard's Parked panel shows as
// the one line explaining why an index is kept.
export function regressionReason(verdict: FailureVerdict & { kind: "INTRODUCED" }): string {
  return verdict.cause === "HINTED"
    ? "queries naming it in a hint failed during observe"
    : `failed operations during observe${kindsOf(verdict.kinds)}`;
}

// The same reading at hide time, as a clause for the HIDE line — so an owner
// learns that a hide is unwatched when it starts, not from the drop at the end
// of the window. Empty when the source records everything.
export function describeWatch(reading: FailedOpsReading): string {
  if (reading.kind === "NO_SOURCE") return `failed operations not watched: ${reading.reason}`;
  return reading.blindSpot === null
    ? ""
    : `failed operations only partly watched: ${reading.blindSpot}`;
}

// And what a baseline short of a day leaves the check able to act on, said at the
// hide for the same reason (#625) — or empty when the baseline is a day.
export function describeShortBaseline(reading: FailedOpsReading, hiddenAtMs: number): string {
  if (reading.kind === "NO_SOURCE") return "";
  const baselineMs = Math.max(0, hiddenAtMs - reading.reachMs);
  if (baselineMs >= FAILURE_BASELINE_MS) return "";
  const what =
    reading.hinted === null
      ? "no failure can roll it back"
      : "only a failed hint at the index can roll it back";
  return (
    `only ${span(baselineMs)} of history before the hide can be read, short of the day it ` +
    `takes to pin a failure on it, so ${what}`
  );
}

// Tallies from several sources as one, largest first.
export function mergeTallies(tallies: readonly FailureTally[]): FailureTally {
  const merged = new Map<string, number>();
  for (const tally of tallies) {
    for (const { kind, failed } of tally) merged.set(kind, (merged.get(kind) ?? 0) + failed);
  }
  return [...merged]
    .map(([kind, failed]) => ({ kind, failed }))
    .sort((a, b) => b.failed - a.failed || a.kind.localeCompare(b.kind));
}

// "2 MaxTimeMSExpired, 1 NoQueryExecutionPlans" — the largest few, and the rest
// as a number, so a collection failing a hundred ways still fits on the line.
const SHOWN_KINDS = 3;
export function tallyText(tally: FailureTally): string {
  const shown = tally.slice(0, SHOWN_KINDS).map(({ kind, failed }) => `${failed} ${kind}`);
  const rest = tally.slice(SHOWN_KINDS).reduce((sum, { failed }) => sum + failed, 0);
  return rest === 0 ? shown.join(", ") : `${shown.join(", ")} and ${rest} of other kinds`;
}

function kindsOf(tally: FailureTally): string {
  return tally.length === 0 ? "" : ` (${tallyText(tally)})`;
}

function notCounted(tally: FailureTally): string {
  return tally.length === 0
    ? ""
    : `; not counted because a hidden index cannot cause them: ${tallyText(tally)}`;
}

function failedOps(n: number): string {
  return counted(n, "failed operation", "failed operations");
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// "54 minutes", "26 hours", "3 days".
export function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return counted(minutes, "minute", "minutes");
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(ms / 86_400_000)} days`;
}

// "2026-10-03 14:05 UTC" — an instant in an audit line, readable in any zone.
export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
