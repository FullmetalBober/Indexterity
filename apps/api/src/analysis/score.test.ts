import { describe, expect, it } from "vitest";
import { createScore, dropScore, RECOMMENDED_AUTO_APPLY_SCORE } from "./score";

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
