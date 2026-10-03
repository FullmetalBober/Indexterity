import { describe, expect, it } from "vitest";
import type { FailedOpsReading } from "../engine/ports";
import {
  describeFailures,
  describeWatch,
  type FailureSample,
  judgeFailures,
  MIN_INTRODUCED_FAILURES,
} from "./failures";

const HIDDEN_AT = 10 * 3_600_000;

// Reach defaults to an hour before the hide, so the scope an INTRODUCED verdict
// states is a real span rather than an artefact of the fixture.
const sample = (failed: number, reachMs = HIDDEN_AT - 3_600_000): FailureSample => ({
  failed,
  reachMs,
});
// The same sample as a reading, which is what the collectors hand back now.
const window = (failed: number, blindSpot: string | null = null): FailedOpsReading => ({
  kind: "WINDOW",
  ...sample(failed),
  blindSpot,
});
const PROFILER_OFF: FailedOpsReading = { kind: "NO_SOURCE", reason: "the profiler is off on app" };
const SLOW_ONLY =
  "the profiler on app keeps only operations slower than 100 ms, and a failed one is fast";
const judge = (before: FailureSample | null, after: FailedOpsReading) =>
  judgeFailures(before, after, HIDDEN_AT);

describe("judgeFailures", () => {
  // The case the whole thing exists for: nothing was failing, the index went
  // hidden, and now things are failing. The latency gate reads this as an
  // improvement, because a query that fails returns faster than one that works.
  it("blames the hide when nothing was failing before it", () => {
    const verdict = judge(sample(0), window(MIN_INTRODUCED_FAILURES));
    expect(verdict).toEqual({
      kind: "INTRODUCED",
      failed: MIN_INTRODUCED_FAILURES,
      // The scope of "none before it": how far back the clean baseline reached.
      baselineMs: 3_600_000,
    });
  });

  // A collection with its own errors must not be able to veto every drop on it
  // forever, so failures that were already happening are reported and not acted
  // on.
  it("will not attribute failures that were already happening", () => {
    const verdict = judge(sample(2), window(50));
    expect(verdict).toEqual({ kind: "INCONCLUSIVE", before: 2, after: 50 });
  });

  // No before is not a clean before. This is the row that must never read as
  // INTRODUCED, because there is nothing to have introduced them against.
  it("will not attribute failures with no baseline to compare against", () => {
    const verdict = judge(null, window(50));
    expect(verdict).toEqual({ kind: "INCONCLUSIVE", before: 0, after: 50 });
  });

  // One stray error is ordinary: applications throw duplicate-key errors and
  // cancel their own queries, and aborting a drop on one of those would make the
  // safest engine the one that never finishes anything.
  it("ignores a failure count below the floor", () => {
    expect(judge(sample(0), window(MIN_INTRODUCED_FAILURES - 1))).toEqual({
      kind: "CLEAN",
      blindSpot: null,
    });
  });

  // Under the floor, but with a dirty baseline — still nothing to act on, and
  // still not something to call clean.
  it("does not call a dirty baseline clean just because the count is low", () => {
    expect(judge(sample(4), window(1))).toEqual({
      kind: "INCONCLUSIVE",
      before: 4,
      after: 1,
    });
  });

  // The signal is one-way. Every source is optional and PostgreSQL has none, so
  // "we could not look" has to be its own answer — a gate demanding this would
  // refuse every drop on every cluster that cannot supply it.
  it("is UNAVAILABLE when there is nothing to read now, and keeps the reason", () => {
    const unavailable = { kind: "UNAVAILABLE", reason: "the profiler is off on app" };
    expect(judge(sample(0), PROFILER_OFF)).toEqual(unavailable);
    expect(judge(null, PROFILER_OFF)).toEqual(unavailable);
  });

  // A profiler keeping only slow operations sees no failures because a failure is
  // fast, not because there were none (#596), so a clean window carries what its
  // source could not see.
  it("keeps the source's blind spot on a clean window", () => {
    expect(judge(sample(0), window(0, SLOW_ONLY))).toEqual({ kind: "CLEAN", blindSpot: SLOW_ONLY });
  });

  // One-way: failures seen are evidence, whatever the source missed besides. A slow
  // failure — a query pushed past maxTimeMS — is exactly what a slow-only profiler
  // does record.
  it("still blames the hide on what a partial source did see", () => {
    expect(judge(sample(0), window(5, SLOW_ONLY))).toMatchObject({ kind: "INTRODUCED", failed: 5 });
  });
});

describe("describeFailures", () => {
  // A gate that ran and cleared the drop must not read the same in the audit
  // trail as a gate that never ran (D19), so all four say something.
  it("says something distinct for every verdict", () => {
    const lines = [
      describeFailures({ kind: "INTRODUCED", failed: 9, baselineMs: 3_600_000 }),
      describeFailures({ kind: "INCONCLUSIVE", before: 2, after: 9 }),
      describeFailures({ kind: "INCONCLUSIVE", before: 0, after: 9 }),
      describeFailures({ kind: "CLEAN", blindSpot: null }),
      describeFailures({ kind: "CLEAN", blindSpot: SLOW_ONLY }),
      describeFailures({ kind: "UNAVAILABLE", reason: "the profiler is off on app" }),
    ];
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });

  // The claim is "none before it", and how far back "before" reached is the
  // difference between that being evidence and being a sentence.
  it("states how far back the clean baseline reached", () => {
    expect(describeFailures({ kind: "INTRODUCED", failed: 9, baselineMs: 3_600_000 })).toContain(
      "60 minutes",
    );
  });

  it("distinguishes a dirty baseline from no baseline at all", () => {
    expect(describeFailures({ kind: "INCONCLUSIVE", before: 2, after: 9 })).toContain("2 before");
    expect(describeFailures({ kind: "INCONCLUSIVE", before: 0, after: 9 })).toContain(
      "nothing to compare against",
    );
  });

  it("never spells a missing source the way it spells a clean window", () => {
    expect(describeFailures({ kind: "UNAVAILABLE", reason: "the profiler is off on app" })).toBe(
      "failed-operations check skipped: the profiler is off on app",
    );
    expect(describeFailures({ kind: "CLEAN", blindSpot: null })).toBe(
      "no failed operations seen since the hide",
    );
  });

  // The production line that prompted #596 read "failed operations could not be
  // read on this cluster" — an error, by the sound of it, naming no cause.
  it("says a skipped check was skipped, and why", () => {
    const line = describeFailures({ kind: "UNAVAILABLE", reason: "the profiler is off on app" });
    expect(line).not.toContain("could not be read");
    expect(line).toContain("skipped");
  });

  it("qualifies a clean window with what its source could not see", () => {
    expect(describeFailures({ kind: "CLEAN", blindSpot: SLOW_ONLY })).toBe(
      `no failed operations seen since the hide, but ${SLOW_ONLY}`,
    );
  });
});

describe("describeWatch", () => {
  // At the hide, so an owner can turn the source on while the window runs.
  it("says when a hide's failures will not be watched, and why", () => {
    expect(describeWatch(PROFILER_OFF)).toBe(
      "failed operations not watched: the profiler is off on app",
    );
  });

  it("says when they will be watched only in part", () => {
    expect(describeWatch(window(0, SLOW_ONLY))).toBe(
      `failed operations only partly watched: ${SLOW_ONLY}`,
    );
  });

  // Nothing to add to a HIDE line when the source records everything.
  it("is silent when the source sees every operation", () => {
    expect(describeWatch(window(0))).toBe("");
  });
});
