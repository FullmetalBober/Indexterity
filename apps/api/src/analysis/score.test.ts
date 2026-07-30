import { describe, expect, it } from "vitest";
import { createScore, dropScore } from "./score";

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
    expect(
      dropScore({
        usageClass: "FLAT_ZERO",
        snapshots: 100,
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
