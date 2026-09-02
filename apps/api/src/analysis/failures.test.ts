import { describe, expect, it } from "vitest";
import {
  describeFailures,
  type FailureSample,
  judgeFailures,
  MIN_INTRODUCED_FAILURES,
} from "./failures";

const sample = (failed: number, reachMs = 0): FailureSample => ({ failed, reachMs });

describe("judgeFailures", () => {
  // The case the whole thing exists for: nothing was failing, the index went
  // hidden, and now things are failing. The latency gate reads this as an
  // improvement, because a query that fails returns faster than one that works.
  it("blames the hide when nothing was failing before it", () => {
    const verdict = judgeFailures(sample(0), sample(MIN_INTRODUCED_FAILURES));
    expect(verdict).toEqual({ kind: "INTRODUCED", failed: MIN_INTRODUCED_FAILURES });
  });

  // A collection with its own errors must not be able to veto every drop on it
  // forever, so failures that were already happening are reported and not acted
  // on.
  it("will not attribute failures that were already happening", () => {
    const verdict = judgeFailures(sample(2), sample(50));
    expect(verdict).toEqual({ kind: "INCONCLUSIVE", before: 2, after: 50 });
  });

  // No before is not a clean before. This is the row that must never read as
  // INTRODUCED, because there is nothing to have introduced them against.
  it("will not attribute failures with no baseline to compare against", () => {
    const verdict = judgeFailures(null, sample(50));
    expect(verdict).toEqual({ kind: "INCONCLUSIVE", before: 0, after: 50 });
  });

  // One stray error is ordinary: applications throw duplicate-key errors and
  // cancel their own queries, and aborting a drop on one of those would make the
  // safest engine the one that never finishes anything.
  it("ignores a failure count below the floor", () => {
    expect(judgeFailures(sample(0), sample(MIN_INTRODUCED_FAILURES - 1))).toEqual({
      kind: "CLEAN",
    });
  });

  // Under the floor, but with a dirty baseline — still nothing to act on, and
  // still not something to call clean.
  it("does not call a dirty baseline clean just because the count is low", () => {
    expect(judgeFailures(sample(4), sample(1))).toEqual({
      kind: "INCONCLUSIVE",
      before: 4,
      after: 1,
    });
  });

  // The signal is one-way. Every source is optional and PostgreSQL has none, so
  // "we could not look" has to be its own answer — a gate demanding this would
  // refuse every drop on every cluster that cannot supply it.
  it("is UNAVAILABLE when there is nothing to read now", () => {
    expect(judgeFailures(sample(0), null)).toEqual({ kind: "UNAVAILABLE" });
    expect(judgeFailures(null, null)).toEqual({ kind: "UNAVAILABLE" });
  });
});

describe("describeFailures", () => {
  // A gate that ran and cleared the drop must not read the same in the audit
  // trail as a gate that never ran (D19), so all four say something.
  it("says something distinct for every verdict", () => {
    const lines = [
      describeFailures({ kind: "INTRODUCED", failed: 9 }),
      describeFailures({ kind: "INCONCLUSIVE", before: 2, after: 9 }),
      describeFailures({ kind: "INCONCLUSIVE", before: 0, after: 9 }),
      describeFailures({ kind: "CLEAN" }),
      describeFailures({ kind: "UNAVAILABLE" }),
    ];
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });

  it("distinguishes a dirty baseline from no baseline at all", () => {
    expect(describeFailures({ kind: "INCONCLUSIVE", before: 2, after: 9 })).toContain("2 before");
    expect(describeFailures({ kind: "INCONCLUSIVE", before: 0, after: 9 })).toContain(
      "nothing to compare against",
    );
  });

  it("never spells a missing source the way it spells a clean window", () => {
    expect(describeFailures({ kind: "UNAVAILABLE" })).toContain("could not be read");
    expect(describeFailures({ kind: "CLEAN" })).toContain("no failed operations seen");
  });
});
