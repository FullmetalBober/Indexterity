import { describe, expect, it } from "vitest";
import { type ActivityPoint, activeHours } from "./activity";

// Cumulative readOps, one point per collect, `hoursApart` between them.
function series(readsPerInterval: readonly number[], hoursApart = 6): ActivityPoint[] {
  const points: ActivityPoint[] = [];
  let total = 0;
  points.push({ capturedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), readOps: total });
  readsPerInterval.forEach((reads, i) => {
    total += reads;
    points.push({
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, (i + 1) * hoursApart * 60)).toISOString(),
      readOps: total,
    });
  });
  return points;
}

describe("activeHours", () => {
  it("counts only the time in which the collection did something", () => {
    // A dev cluster: busy for one stretch, idle the rest of the week. Two active
    // intervals at six hours each.
    expect(activeHours(series([0, 0, 40, 12, 0, 0, 0, 0]))).toBe(12);
  });

  it("is zero for a cluster that is up but never queried", () => {
    expect(activeHours(series([0, 0, 0, 0]))).toBe(0);
  });

  it("counts the whole span for a continuously busy collection", () => {
    expect(activeHours(series([5, 5, 5, 5]))).toBe(24);
  });

  it("drops an interval whose counter restarted rather than guessing", () => {
    const points: ActivityPoint[] = [
      { capturedAt: "2026-01-01T00:00:00Z", readOps: 900 },
      { capturedAt: "2026-01-01T06:00:00Z", readOps: 1000 },
      // mongod restarted: the counter is back near zero.
      { capturedAt: "2026-01-01T12:00:00Z", readOps: 5 },
      { capturedAt: "2026-01-01T18:00:00Z", readOps: 60 },
    ];
    expect(activeHours(points)).toBe(12);
  });

  it("needs two points before any interval exists", () => {
    expect(activeHours([])).toBe(0);
    expect(activeHours([{ capturedAt: "2026-01-01T00:00:00Z", readOps: 10 }])).toBe(0);
  });

  // The whole reason this returns hours. The threshold reading it wants "three
  // days of genuine traffic"; when this counted intervals, that was only true
  // while an interval was six hours. Twelve intervals at fifteen minutes is three
  // HOURS, and nothing in the engine or its tests would have noticed.
  it.each([
    ["6h", 6],
    ["1h", 1],
    ["15m", 0.25],
  ])("reports the same active time at a %s cadence", (_label, hours) => {
    // Busy throughout: 24 hours of wall clock, whatever the sampling rate.
    const intervals = Math.round(24 / hours);
    const busy = Array.from({ length: intervals }, () => 5);
    expect(activeHours(series(busy, hours))).toBeCloseTo(24, 6);
  });

  // Without the cap, one outage could manufacture the evidence a drop needs: the
  // counter moved somewhere inside a 30-hour hole, so the hole would be credited
  // as 30 hours of traffic. What is known is that the collection was used
  // somewhere in there, not throughout.
  it("credits a long hole at the usual cadence, not at its own length", () => {
    const points: ActivityPoint[] = [
      { capturedAt: "2026-01-01T00:00:00Z", readOps: 0 },
      { capturedAt: "2026-01-01T06:00:00Z", readOps: 10 },
      { capturedAt: "2026-01-01T12:00:00Z", readOps: 20 },
      // Went dark for thirty hours, and traffic happened at some point in there.
      { capturedAt: "2026-01-02T18:00:00Z", readOps: 30 },
    ];
    // Three active intervals, the last capped at the 6h median rather than 30h.
    expect(activeHours(points)).toBe(18);
  });

  it("still counts a short interval at its real length", () => {
    const points: ActivityPoint[] = [
      { capturedAt: "2026-01-01T00:00:00Z", readOps: 0 },
      { capturedAt: "2026-01-01T06:00:00Z", readOps: 10 },
      { capturedAt: "2026-01-01T12:00:00Z", readOps: 20 },
      // A catch-up collect an hour later: an hour of activity, not six.
      { capturedAt: "2026-01-01T13:00:00Z", readOps: 25 },
    ];
    expect(activeHours(points)).toBe(13);
  });
});
