import { describe, expect, it } from "vitest";
import type { FailedOpsReading, FailedOpsWindow, FailureTally } from "../engine/ports";
import {
  describeFailures,
  describeShortBaseline,
  describeWatch,
  FAILURE_BASELINE_MS,
  type FailureSample,
  type FailureVerdict,
  judgeFailures,
  MIN_INTRODUCED_FAILURES,
  mergeTallies,
  regressionReason,
  span,
  tallyText,
} from "./failures";

const HIDDEN_AT = 10 * FAILURE_BASELINE_MS;
const HOUR = 3_600_000;

// Reach defaults to a day and an hour before the hide, so a clean baseline is a
// real one unless a test says otherwise.
const sample = (
  failed: number,
  reachMs = HIDDEN_AT - FAILURE_BASELINE_MS - HOUR,
): FailureSample => ({
  failed,
  reachMs,
});
const MAX_TIME: FailureTally = [{ kind: "MaxTimeMSExpired", failed: 3 }];
const DUPLICATES: FailureTally = [{ kind: "DuplicateKey", failed: 3 }];
// A reading as the MongoDB collector hands it back: nothing failed unless a test
// says what did.
const window = (failures: Partial<FailedOpsWindow> = {}): FailedOpsReading => ({
  kind: "WINDOW",
  hinted: 0,
  suspect: 0,
  suspectKinds: [],
  unrelated: [],
  reachMs: HIDDEN_AT - FAILURE_BASELINE_MS - HOUR,
  blindSpot: null,
  ...failures,
});
const suspect = (kinds: FailureTally, rest: Partial<FailedOpsWindow> = {}): FailedOpsReading =>
  window({
    suspect: kinds.reduce((sum, { failed }) => sum + failed, 0),
    suspectKinds: kinds,
    ...rest,
  });
const PROFILER_OFF: FailedOpsReading = { kind: "NO_SOURCE", reason: "the profiler is off on app" };
const SLOW_ONLY =
  "the profiler on app keeps only operations slower than 100 ms, and a failed one is fast";
const judge = (before: FailureSample | null, after: FailedOpsReading) =>
  judgeFailures(before, after, HIDDEN_AT);

describe("judgeFailures", () => {
  // The case D183 armed the profiler for: a hint at the index fails in 0 ms once
  // it is hidden, and the latency gate reads that as an improvement.
  it("blames the hide for a single failed hint at the index, whatever the baseline", () => {
    for (const before of [sample(0), sample(5), sample(0, HIDDEN_AT - 60_000), null]) {
      expect(judge(before, window({ hinted: 1, unrelated: DUPLICATES }))).toEqual({
        kind: "INTRODUCED",
        cause: "HINTED",
        failed: 1,
        unrelated: DUPLICATES,
      });
    }
  });

  it("blames the hide for suspect failures after a clean day", () => {
    expect(judge(sample(0), suspect(MAX_TIME))).toEqual({
      kind: "INTRODUCED",
      cause: "SUSPECT",
      failed: 3,
      kinds: MAX_TIME,
      // The scope of "none before it": how far back the clean baseline reached.
      baselineMs: FAILURE_BASELINE_MS + HOUR,
      unrelated: [],
    });
  });

  // #625, as production read it: three failures after the hide, none in the 54
  // minutes the ring still held before it. Whatever they were, 54 minutes is not
  // the day a nightly job needs to show up in.
  it("will not attribute suspect failures to a baseline short of a day", () => {
    const short = HIDDEN_AT - 54 * 60_000;
    expect(judge(sample(0, short), suspect(MAX_TIME))).toEqual({
      kind: "INCONCLUSIVE",
      failed: 3,
      kinds: MAX_TIME,
      because: { kind: "SHORT_BASELINE", baselineMs: 54 * 60_000 },
      unrelated: [],
    });
  });

  // #625 the other way: the same three failures, of a kind no hidden index causes.
  it("counts nothing a hidden index cannot cause, and keeps it for the line", () => {
    expect(judge(sample(0), window({ unrelated: DUPLICATES }))).toEqual({
      kind: "CLEAN",
      blindSpot: null,
      unrelated: DUPLICATES,
    });
  });

  // A collection with its own errors must not be able to veto every drop on it
  // forever, so failures that were already happening are reported and not acted
  // on.
  it("will not attribute failures that were already happening", () => {
    expect(judge(sample(2), suspect(MAX_TIME))).toMatchObject({
      kind: "INCONCLUSIVE",
      because: { kind: "FAILING_BEFORE", failed: 2 },
    });
  });

  // No before is not a clean before. This is the row that must never read as
  // INTRODUCED, because there is nothing to have introduced them against.
  it("will not attribute failures with no baseline to compare against", () => {
    expect(judge(null, suspect(MAX_TIME))).toMatchObject({
      kind: "INCONCLUSIVE",
      because: { kind: "NO_BASELINE" },
    });
  });

  // One stray timeout is ordinary, and aborting a drop on one would make the
  // safest engine the one that never finishes anything.
  it("does not act below the floor, and says so rather than calling it clean", () => {
    const few: FailureTally = [{ kind: "MaxTimeMSExpired", failed: MIN_INTRODUCED_FAILURES - 1 }];
    expect(judge(sample(0), suspect(few))).toMatchObject({
      kind: "INCONCLUSIVE",
      because: { kind: "FEW" },
    });
  });

  // Nothing seen since the hide is clean whatever came before it.
  it("is clean when nothing has failed since the hide", () => {
    expect(judge(sample(4), window())).toEqual({ kind: "CLEAN", blindSpot: null, unrelated: [] });
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
    expect(judge(sample(0), window({ blindSpot: SLOW_ONLY }))).toEqual({
      kind: "CLEAN",
      blindSpot: SLOW_ONLY,
      unrelated: [],
    });
  });

  // One-way: failures seen are evidence, whatever the source missed besides. A slow
  // failure — a query pushed past maxTimeMS — is exactly what a slow-only profiler
  // does record.
  it("still blames the hide on what a partial source did see", () => {
    expect(judge(sample(0), suspect(MAX_TIME, { blindSpot: SLOW_ONLY }))).toMatchObject({
      kind: "INTRODUCED",
      cause: "SUSPECT",
      failed: 3,
    });
  });

  // SQL Server's Query Store names no kinds and no hints: every failure is
  // suspect, and judged as one.
  it("judges a source that cannot sort its failures on the suspect rule", () => {
    const store = window({ hinted: null, suspect: 4 });
    expect(judge(sample(0), store)).toMatchObject({ kind: "INTRODUCED", cause: "SUSPECT" });
    expect(judge(sample(0, HIDDEN_AT - HOUR), store)).toMatchObject({
      kind: "INCONCLUSIVE",
      because: { kind: "SHORT_BASELINE" },
    });
  });
});

describe("describeFailures", () => {
  const hinted: FailureVerdict = {
    kind: "INTRODUCED",
    cause: "HINTED",
    failed: 3,
    unrelated: [],
  };
  const introduced: FailureVerdict = {
    kind: "INTRODUCED",
    cause: "SUSPECT",
    failed: 3,
    kinds: MAX_TIME,
    baselineMs: 26 * HOUR,
    unrelated: [],
  };
  const unattributed = (because: Extract<FailureVerdict, { kind: "INCONCLUSIVE" }>["because"]) =>
    ({ kind: "INCONCLUSIVE", failed: 3, kinds: MAX_TIME, because, unrelated: [] }) as const;

  // A gate that ran and cleared the drop must not read the same in the audit
  // trail as a gate that never ran (D19), so every verdict says something.
  it("says something distinct for every verdict", () => {
    const lines = [
      describeFailures(hinted),
      describeFailures(introduced),
      describeFailures(unattributed({ kind: "FAILING_BEFORE", failed: 2 })),
      describeFailures(unattributed({ kind: "NO_BASELINE" })),
      describeFailures(unattributed({ kind: "FEW" })),
      describeFailures(unattributed({ kind: "SHORT_BASELINE", baselineMs: 54 * 60_000 })),
      describeFailures({ kind: "CLEAN", blindSpot: null, unrelated: [] }),
      describeFailures({ kind: "CLEAN", blindSpot: SLOW_ONLY, unrelated: [] }),
      describeFailures({ kind: "CLEAN", blindSpot: null, unrelated: DUPLICATES }),
      describeFailures({ kind: "UNAVAILABLE", reason: "the profiler is off on app" }),
    ];
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });

  it("says a failed hint is why, which needs no baseline", () => {
    expect(describeFailures(hinted)).toBe(
      "3 queries naming the index in a hint failed since the hide, which a hidden index refuses",
    );
  });

  // The claim is "none before it", and how far back "before" reached is the
  // difference between that being evidence and being a sentence.
  it("says what failed, and how far back the clean baseline reached", () => {
    expect(describeFailures(introduced)).toBe(
      "3 failed operations since the hide (3 MaxTimeMSExpired), and none in the 26 hours of history readable before it",
    );
  });

  // The line production should have written for #625.
  it("says a baseline was too short to pin anything on the hide", () => {
    expect(
      describeFailures(unattributed({ kind: "SHORT_BASELINE", baselineMs: 54 * 60_000 })),
    ).toBe(
      "3 failed operations since the hide (3 MaxTimeMSExpired), but only 54 minutes of history before it could be read, short of the day it takes to pin them on the hide — not attributed",
    );
  });

  it("distinguishes a dirty baseline from no baseline at all", () => {
    expect(describeFailures(unattributed({ kind: "FAILING_BEFORE", failed: 2 }))).toContain(
      "but 2 before it",
    );
    expect(describeFailures(unattributed({ kind: "NO_BASELINE" }))).toContain(
      "nothing to compare against",
    );
  });

  // A reader who finds failures on the collection deserves to be told why they
  // did not count.
  it("names what it did not count, and why", () => {
    expect(describeFailures({ kind: "CLEAN", blindSpot: null, unrelated: DUPLICATES })).toBe(
      "no failed operations a hidden index can cause seen since the hide; not counted because a hidden index cannot cause them: 3 DuplicateKey",
    );
    expect(describeFailures({ ...hinted, unrelated: DUPLICATES })).toContain(
      "; not counted because a hidden index cannot cause them: 3 DuplicateKey",
    );
  });

  it("never spells a missing source the way it spells a clean window", () => {
    expect(describeFailures({ kind: "UNAVAILABLE", reason: "the profiler is off on app" })).toBe(
      "failed-operations check skipped: the profiler is off on app",
    );
    expect(describeFailures({ kind: "CLEAN", blindSpot: null, unrelated: [] })).toBe(
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
    expect(describeFailures({ kind: "CLEAN", blindSpot: SLOW_ONLY, unrelated: [] })).toBe(
      `no failed operations seen since the hide, but ${SLOW_ONLY}`,
    );
  });

  // SQL Server names no kinds, so there is nothing to put in brackets.
  it("leaves out the kinds where the source names none", () => {
    expect(describeFailures({ ...introduced, kinds: [] })).toBe(
      "3 failed operations since the hide, and none in the 26 hours of history readable before it",
    );
  });
});

describe("regressionReason", () => {
  // The Parked panel's one line about why an index is kept.
  it("says which kind of failure parked the index", () => {
    expect(
      regressionReason({ kind: "INTRODUCED", cause: "HINTED", failed: 1, unrelated: [] }),
    ).toBe("queries naming it in a hint failed during observe");
    expect(
      regressionReason({
        kind: "INTRODUCED",
        cause: "SUSPECT",
        failed: 3,
        kinds: MAX_TIME,
        baselineMs: FAILURE_BASELINE_MS,
        unrelated: [],
      }),
    ).toBe("failed operations during observe (3 MaxTimeMSExpired)");
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
    expect(describeWatch(window({ blindSpot: SLOW_ONLY }))).toBe(
      `failed operations only partly watched: ${SLOW_ONLY}`,
    );
  });

  // Nothing to add to a HIDE line when the source records everything.
  it("is silent when the source sees every operation", () => {
    expect(describeWatch(window())).toBe("");
  });
});

describe("describeShortBaseline", () => {
  // Said at the hide (#625): on a database whose ring turns over in an hour, only a
  // hint can roll the hide back, and the owner should know that when it starts.
  it("says what a baseline short of a day leaves the check able to act on", () => {
    expect(describeShortBaseline(window({ reachMs: HIDDEN_AT - 54 * 60_000 }), HIDDEN_AT)).toBe(
      "only 54 minutes of history before the hide can be read, short of the day it takes to pin a failure on it, so only a failed hint at the index can roll it back",
    );
  });

  it("says nothing can, where the source cannot tell a hint", () => {
    expect(
      describeShortBaseline(window({ hinted: null, reachMs: HIDDEN_AT - HOUR }), HIDDEN_AT),
    ).toContain("so no failure can roll it back");
  });

  it("is silent for a day of baseline, and for no source", () => {
    expect(describeShortBaseline(window(), HIDDEN_AT)).toBe("");
    expect(describeShortBaseline(PROFILER_OFF, HIDDEN_AT)).toBe("");
  });
});

describe("tallies", () => {
  it("merges by kind, largest first", () => {
    expect(
      mergeTallies([
        [{ kind: "DuplicateKey", failed: 1 }],
        [
          { kind: "DocumentValidationFailure", failed: 2 },
          { kind: "DuplicateKey", failed: 2 },
        ],
      ]),
    ).toEqual([
      { kind: "DuplicateKey", failed: 3 },
      { kind: "DocumentValidationFailure", failed: 2 },
    ]);
  });

  // A collection failing a hundred ways still fits on the line.
  it("names the largest three and counts the rest", () => {
    const many = ["A", "B", "C", "D", "E"].map((kind, i) => ({ kind, failed: 5 - i }));
    expect(tallyText(many)).toBe("5 A, 4 B, 3 C and 3 of other kinds");
  });

  it("spells a span in the unit a reader would", () => {
    expect(span(60_000)).toBe("1 minute");
    expect(span(54 * 60_000)).toBe("54 minutes");
    expect(span(26 * HOUR)).toBe("26 hours");
    expect(span(3 * FAILURE_BASELINE_MS)).toBe("3 days");
  });
});
