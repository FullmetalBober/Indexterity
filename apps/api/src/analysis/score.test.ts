import { describe, expect, it } from "vitest";
import { createScore, dropScore, narrowScore, RECOMMENDED_AUTO_APPLY_SCORE } from "./score";

describe("dropScore", () => {
  it("scores a long-dead sizable index high", () => {
    const score = dropScore({
      usageClass: "FLAT_ZERO",
      snapshots: 12,
      redundant: false,
      sizeBytes: 1024 ** 3,
      pastRegressions: 0,
    });
    expect(score).toBeGreaterThanOrEqual(70);
  });

  // The top of the range has to exist, or a threshold above it approves
  // nothing while looking like a valid setting.
  it("reaches 100 for the strongest case the engine can make", () => {
    expect(
      dropScore({
        usageClass: null,
        snapshots: 125,
        redundant: true,
        sizeBytes: 1024 ** 3,
        pastRegressions: 0,
      }),
    ).toBe(100);
  });

  it("needs a month of history for full evidence credit, not two days", () => {
    const base = {
      usageClass: "FLAT_ZERO" as const,
      redundant: false,
      sizeBytes: 0,
      pastRegressions: 0,
    };
    // 10 snapshots is 2.5 days at the 6h cadence — it used to max the term out.
    expect(dropScore({ ...base, snapshots: 10 })).toBeLessThan(
      dropScore({ ...base, snapshots: 125 }),
    );
  });

  it("clears the recommended threshold on evidence, and not without it", () => {
    // Redundant, a month of history, a gigabyte back.
    expect(
      dropScore({
        usageClass: null,
        snapshots: 125,
        redundant: true,
        sizeBytes: 1024 ** 3,
        pastRegressions: 0,
      }),
    ).toBeGreaterThanOrEqual(RECOMMENDED_AUTO_APPLY_SCORE);
    // Was periodic and went quiet, thin history, tiny index — a human's call.
    expect(
      dropScore({
        usageClass: "PERIODIC_DEAD",
        snapshots: 15,
        redundant: false,
        sizeBytes: 4096,
        pastRegressions: 0,
      }),
    ).toBeLessThan(RECOMMENDED_AUTO_APPLY_SCORE);
  });
  it("scores redundancy high even with live usage", () => {
    const score = dropScore({
      usageClass: null,
      snapshots: 5,
      redundant: true,
      sizeBytes: 0,
      pastRegressions: 0,
    });
    expect(score).toBeGreaterThanOrEqual(50);
  });
  it("past regressions collapse the score", () => {
    const clean = dropScore({
      usageClass: "FLAT_ZERO",
      snapshots: 10,
      redundant: false,
      sizeBytes: 0,
      pastRegressions: 0,
    });
    const burned = dropScore({
      usageClass: "FLAT_ZERO",
      snapshots: 10,
      redundant: false,
      sizeBytes: 0,
      pastRegressions: 1,
    });
    expect(burned).toBeLessThan(clean - 30);
  });
  it("clamps to 0..100", () => {
    // The terms sum to exactly 100 at their caps, so overshooting means
    // exceeding every cap at once.
    expect(
      dropScore({
        usageClass: "FLAT_ZERO",
        snapshots: 10_000,
        redundant: true,
        sizeBytes: 10 * 1024 ** 3,
        pastRegressions: 0,
      }),
    ).toBe(100);
    expect(
      dropScore({
        usageClass: null,
        snapshots: 0,
        redundant: false,
        sizeBytes: 0,
        pastRegressions: 3,
      }),
    ).toBe(0);
  });
});

describe("createScore", () => {
  it("scores a hot collscan on a critical collection high", () => {
    expect(
      createScore({ collscan: true, count: 30, docCount: 50_000, pastRegressions: 0 }),
    ).toBeGreaterThanOrEqual(75);
  });

  it("scores an in-memory sort below the same shape scanning", () => {
    const base = { count: 30, docCount: 50_000, pastRegressions: 0 };
    const sorting = createScore({ ...base, collscan: false, sortedInMemory: true });
    const scanning = createScore({ ...base, collscan: true });
    expect(sorting).toBeLessThan(scanning);
    // Still an argument, not a footnote: the sort can fail outright at 100 MB.
    expect(sorting).toBeGreaterThanOrEqual(50);
  });

  it("gives no create credit to a shape that neither scans nor sorts", () => {
    const idle = createScore({ collscan: false, count: 30, docCount: 50_000, pastRegressions: 0 });
    expect(idle).toBeLessThan(
      createScore({
        collscan: false,
        sortedInMemory: true,
        count: 30,
        docCount: 50_000,
        pastRegressions: 0,
      }),
    );
  });

  it("reaches 100 for a constant, critically costly scan on a huge collection", () => {
    expect(
      createScore({
        collscan: true,
        count: 35,
        docCount: 1_000_000,
        severity: "CRITICAL",
        pastRegressions: 0,
      }),
    ).toBe(100);
  });

  it("ranks a measured-critical scan above an identical one that is not", () => {
    const base = { collscan: true, count: 10, docCount: 50_000, pastRegressions: 0 } as const;
    expect(createScore({ ...base, severity: "CRITICAL" })).toBeGreaterThan(
      createScore({ ...base, severity: "ROUTINE" }),
    );
  });
  it("a single scan on a small collection stays modest", () => {
    expect(
      createScore({ collscan: true, count: 1, docCount: 1500, pastRegressions: 0 }),
    ).toBeLessThan(50);
  });
  it("past rollback collapses the score", () => {
    expect(
      createScore({ collscan: true, count: 30, docCount: 50_000, pastRegressions: 2 }),
    ).toBeLessThanOrEqual(10);
  });
});

describe("narrowScore", () => {
  const strong = {
    observedCount: 5000,
    droppedKeys: 2,
    totalKeys: 3,
    sizeBytes: 4 * 1024 ** 3,
    pastRegressions: 0,
  } as const;

  // The whole point of the ceiling: narrowing argues from absence of evidence,
  // so it always waits for a human however good the case looks.
  it("cannot reach the recommended auto-apply threshold", () => {
    expect(narrowScore(strong)).toBeLessThan(RECOMMENDED_AUTO_APPLY_SCORE);
  });

  it("rewards traffic behind the claim", () => {
    expect(narrowScore(strong)).toBeGreaterThan(narrowScore({ ...strong, observedCount: 20 }));
  });

  it("rewards reclaiming more of a bigger index", () => {
    expect(narrowScore(strong)).toBeGreaterThan(narrowScore({ ...strong, sizeBytes: 1024 }));
    expect(narrowScore(strong)).toBeGreaterThan(
      narrowScore({ ...strong, droppedKeys: 1, totalKeys: 6 }),
    );
  });

  it("a thin sample on a small index barely registers", () => {
    expect(
      narrowScore({
        observedCount: 3,
        droppedKeys: 1,
        totalKeys: 4,
        sizeBytes: 1024,
        pastRegressions: 0,
      }),
    ).toBeLessThan(25);
  });

  // The cooldown already blocks re-proposal outright for a period; once it
  // expires the score has to carry the memory.
  it("past rollback collapses the score", () => {
    expect(narrowScore({ ...strong, pastRegressions: 1 })).toBeLessThan(20);
    expect(narrowScore({ ...strong, pastRegressions: 2 })).toBe(0);
  });
});
