import { describe, expect, it } from "vitest";
import { type ActivityPoint, activeIntervals } from "./activity";

// Cumulative readOps, one point per collect.
function series(readsPerInterval: readonly number[]): ActivityPoint[] {
  const points: ActivityPoint[] = [];
  let total = 0;
  points.push({ capturedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), readOps: total });
  readsPerInterval.forEach((reads, i) => {
    total += reads;
    points.push({
      capturedAt: new Date(Date.UTC(2026, 0, 1, (i + 1) * 6)).toISOString(),
      readOps: total,
    });
  });
  return points;
}

describe("activeIntervals", () => {
  it("counts only the intervals where the collection did something", () => {
    // A dev cluster: busy for one stretch, idle the rest of the week.
    expect(activeIntervals(series([0, 0, 40, 12, 0, 0, 0, 0]))).toBe(2);
  });

  it("is zero for a cluster that is up but never queried", () => {
    expect(activeIntervals(series([0, 0, 0, 0]))).toBe(0);
  });

  it("counts every interval for a continuously busy collection", () => {
    expect(activeIntervals(series([5, 5, 5, 5]))).toBe(4);
  });

  it("drops an interval whose counter restarted rather than guessing", () => {
    const points: ActivityPoint[] = [
      { capturedAt: "2026-01-01T00:00:00Z", readOps: 900 },
      { capturedAt: "2026-01-01T06:00:00Z", readOps: 1000 },
      // mongod restarted: the counter is back near zero.
      { capturedAt: "2026-01-01T12:00:00Z", readOps: 5 },
      { capturedAt: "2026-01-01T18:00:00Z", readOps: 60 },
    ];
    expect(activeIntervals(points)).toBe(2);
  });

  it("needs two points before any interval exists", () => {
    expect(activeIntervals([])).toBe(0);
    expect(activeIntervals([{ capturedAt: "2026-01-01T00:00:00Z", readOps: 10 }])).toBe(0);
  });
});
