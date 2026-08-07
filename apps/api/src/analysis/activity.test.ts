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
  // Run-length storage: the collector stops writing a row per collect once the
  // counter holds still, and extends the one it has instead.
  describe("over run-length readings", () => {
    it("credits a quiet run nothing, however long it is", () => {
      // Thirty days of collects that never saw the read counter move. One row,
      // a hundred and twenty looks, and no traffic at all — crediting the run's
      // own length would let a month of idleness fund the drops the activity
      // gate exists to withhold.
      const points: ActivityPoint[] = [
        {
          capturedAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-31T00:00:00Z",
          observations: 120,
          readOps: 500,
        },
      ];
      expect(activeHours(points)).toBe(0);
    });

    it("puts the traffic in the gap between two runs", () => {
      // Quiet for a day, one busy interval, quiet for a day. The reads happened
      // between the first run's end and the second's start, and nowhere else.
      const points: ActivityPoint[] = [
        {
          capturedAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-02T00:00:00Z",
          observations: 5,
          readOps: 0,
        },
        {
          capturedAt: "2026-01-02T06:00:00Z",
          lastSeenAt: "2026-01-03T06:00:00Z",
          observations: 5,
          readOps: 40,
        },
      ];
      // One active interval, the 6h gap between the runs.
      expect(activeHours(points)).toBe(6);
    });

    it("matches the point-reading answer for a series with nothing to collapse", () => {
      // A busy collection's counter moves every collect, so run-length changes
      // nothing about it — and the arithmetic has to agree.
      const collapsed: ActivityPoint[] = [
        {
          capturedAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-01T00:00:00Z",
          observations: 1,
          readOps: 0,
        },
        {
          capturedAt: "2026-01-01T06:00:00Z",
          lastSeenAt: "2026-01-01T06:00:00Z",
          observations: 1,
          readOps: 10,
        },
        {
          capturedAt: "2026-01-01T12:00:00Z",
          lastSeenAt: "2026-01-01T12:00:00Z",
          observations: 1,
          readOps: 20,
        },
      ];
      const points: ActivityPoint[] = [
        { capturedAt: "2026-01-01T00:00:00Z", readOps: 0 },
        { capturedAt: "2026-01-01T06:00:00Z", readOps: 10 },
        { capturedAt: "2026-01-01T12:00:00Z", readOps: 20 },
      ];
      expect(activeHours(collapsed)).toBe(activeHours(points));
    });

    it("takes the cadence from the collects inside a run, not from its length", () => {
      // Without weighting the median by observation count, this run's span would
      // vote once as a 30-day "gap" and the cap would balloon, letting the one
      // real interval be credited far past the cadence.
      const points: ActivityPoint[] = [
        {
          capturedAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-31T00:00:00Z",
          observations: 121,
          readOps: 0,
        },
        { capturedAt: "2026-01-31T06:00:00Z", readOps: 99 },
      ];
      expect(activeHours(points)).toBe(6);
    });
  });
});
