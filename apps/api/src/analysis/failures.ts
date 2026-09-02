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
// exceeds the 100 MB limit and fails rather than slows, a driver-level timeout.
//
// ONE-WAY, and the whole design rests on it. Failures seen are evidence;
// failures unseen are nothing, because every source is optional (the MongoDB
// profiler, SQL Server's Query Store) and PostgreSQL has none at all. A gate
// that demanded this signal would refuse every drop on every cluster that does
// not supply it, which is not caution — it is the product not working. So the
// verdict here can turn a graduation into a rollback and can never do the
// reverse.

export interface FailureSample {
  readonly failed: number;
  // How far back the source could see when the sample was taken, epoch ms.
  readonly reachMs: number;
}

// Judgement, not a measurement, and named as one — there is no honest way to
// measure "how many errors mean the hide did it" without the application in
// front of you.
//
// Three rather than one, because a single failure is ordinary: applications
// throw duplicate-key errors and cancel queries on their own schedule, and
// aborting a drop on one of those would make the safest engine the one that
// never finishes anything. Three rather than thirty, because the failure mode
// this exists for is not a rate — a hidden text index fails EVERY $text query,
// so the count is the traffic, and any floor a real breakage does not clear
// instantly is a floor set too high.
export const MIN_INTRODUCED_FAILURES = 3;

export type FailureVerdict =
  // The hide is implicated: nothing was failing before it and something is now.
  //
  // `baselineMs` is how far back the clean baseline actually reached, and it is on
  // the verdict because it is the SCOPE of the claim rather than decoration. It is
  // deliberately not a gate: a short reach means a BUSY collection (the ring filled
  // fast, so those seconds hold many operations) and a long one means a quiet
  // collection, so time-reach is no proxy for how much evidence "none before" is.
  // Recorded in the audit line instead, where a reader can weigh it.
  | { readonly kind: "INTRODUCED"; readonly failed: number; readonly baselineMs: number }
  // Failures exist but cannot be attributed to the hide — they were already
  // happening, or there is no before to compare against. Reported, never acted
  // on: aborting here would let a collection with its own pre-existing errors
  // veto every drop on it forever.
  | { readonly kind: "INCONCLUSIVE"; readonly before: number; readonly after: number }
  // Nothing seen since the hide. Which is NOT "nothing happened" — see reachMs.
  | { readonly kind: "CLEAN" }
  // No source, so no question was asked.
  | { readonly kind: "UNAVAILABLE" };

export function judgeFailures(
  // Sampled at hide time, over whatever window the source could then see.
  before: FailureSample | null,
  // Sampled now, counting only what happened at or after the hide.
  after: FailureSample | null,
  // When the hide happened, so the baseline's reach can be stated as a span.
  hiddenAtMs: number,
): FailureVerdict {
  if (after === null) return { kind: "UNAVAILABLE" };
  if (after.failed < MIN_INTRODUCED_FAILURES) {
    // Below the floor is not the same as clean when there IS a before that was
    // dirty, but it is the same decision, and calling it CLEAN would be the one
    // thing this file refuses to do — claim more than was seen. Nothing to act
    // on either way.
    return before !== null && before.failed > 0
      ? { kind: "INCONCLUSIVE", before: before.failed, after: after.failed }
      : { kind: "CLEAN" };
  }
  if (before === null || before.failed > 0) {
    return { kind: "INCONCLUSIVE", before: before?.failed ?? 0, after: after.failed };
  }
  return {
    kind: "INTRODUCED",
    failed: after.failed,
    baselineMs: Math.max(0, hiddenAtMs - before.reachMs),
  };
}

// The audit line, in the words the action trail keeps. Every verdict says
// something, including the two that change nothing — a gate that ran and found
// nothing must not read the same as a gate that never ran (D19).
export function describeFailures(verdict: FailureVerdict): string {
  switch (verdict.kind) {
    case "INTRODUCED":
      return (
        `${verdict.failed} failed operations since the hide, and none in the ` +
        `${Math.round(verdict.baselineMs / 60_000)} minutes of history readable before it`
      );
    case "INCONCLUSIVE":
      return `${verdict.after} failed operations since the hide, but ${
        verdict.before === 0 ? "nothing to compare against" : `${verdict.before} before it`
      } — not attributed`;
    case "CLEAN":
      return "no failed operations seen since the hide";
    case "UNAVAILABLE":
      return "failed operations could not be read on this cluster";
  }
}
