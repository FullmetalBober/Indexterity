import { describe, expect, it } from "vitest";
import { type LatencyReading, latencyPoints, summarizeLatency } from "./latency";

function reading(
  readOps: number,
  readLatencyMicros: number,
  writeOps: number,
  writeLatencyMicros: number,
  hour: number,
): LatencyReading {
  return {
    readOps,
    readLatencyMicros,
    writeOps,
    writeLatencyMicros,
    capturedAt: `2026-07-25T0${hour}:00:00Z`,
  };
}

const series = [
  reading(100, 100_000, 10, 20_000, 0),
  reading(200, 200_000, 20, 60_000, 1),
  reading(300, 250_000, 30, 130_000, 2),
];

describe("summarizeLatency", () => {
  it("computes windowed before/after averages and deltas", () => {
    const trend = summarizeLatency(series);
    expect(trend.samples).toBe(3);
    expect(trend.baselineReadMicros).toBe(1000);
    expect(trend.currentReadMicros).toBe(500);
    expect(trend.readDeltaPct).toBe(-50);
    expect(trend.baselineWriteMicros).toBe(4000);
    expect(trend.currentWriteMicros).toBe(7000);
    expect(trend.writeDeltaPct).toBe(75);
  });
  it("is order-independent (sorts by capturedAt)", () => {
    const reversed = [...series].reverse();
    expect(summarizeLatency(reversed).readDeltaPct).toBe(-50);
  });
  it("nulls when a single sample gives no window", () => {
    const trend = summarizeLatency([reading(1, 1, 1, 1, 0)]);
    expect(trend.currentReadMicros).toBeNull();
    expect(trend.readDeltaPct).toBeNull();
  });
  it("skips a window where ops did not advance", () => {
    const trend = summarizeLatency([
      reading(100, 100_000, 0, 0, 0),
      reading(100, 100_000, 0, 0, 1),
    ]);
    expect(trend.currentReadMicros).toBeNull();
  });
});

// A mongod restart zeroes $collStats latencyStats, so the next reading is SMALLER
// than the one before it. Differencing the pair gives negative latency, which was
// shown to the customer as an extremely fast collection — observed at -6,803 µs/op
// across 81 of 98 collections on one cluster, because a restart resets every
// namespace together. There is no `since` to check the way index usage has: the
// total having fallen is the only evidence there is.
describe("summarizeLatency across a counter reset", () => {
  it("refuses to report negative latency when the read total falls", () => {
    // The real numbers from the cluster that surfaced this.
    const restarted = [reading(13, 36_627, 0, 0, 0), reading(15, 23_020, 0, 0, 1)];
    const trend = summarizeLatency(restarted);
    expect(trend.currentReadMicros).toBeNull();
    expect(trend.baselineReadMicros).toBeNull();
    expect(trend.readDeltaPct).toBeNull();
  });

  it("does the same for writes", () => {
    const restarted = [reading(0, 0, 40, 80_000, 0), reading(0, 0, 45, 9_000, 1)];
    expect(summarizeLatency(restarted).currentWriteMicros).toBeNull();
  });

  it("keeps the windows either side of the reset", () => {
    // Rose, reset, rose again. The two good intervals still count; only the one
    // spanning the reset is unknown, so a restart costs one window and not the
    // whole history.
    const across = [
      reading(100, 100_000, 0, 0, 0),
      reading(200, 220_000, 0, 0, 1),
      reading(10, 8_000, 0, 0, 2),
      reading(30, 32_000, 0, 0, 3),
    ];
    const trend = summarizeLatency(across);
    expect(trend.baselineReadMicros).toBe(1200);
    expect(trend.currentReadMicros).toBe(1200);
    expect(trend.samples).toBe(4);
  });

  it("still reports zero micros over real ops, which is not a reset", () => {
    // A delta of exactly zero is a legitimate reading — ops that cost nothing
    // measurable — and must not be swept up with the negatives.
    const flat = [reading(100, 50_000, 0, 0, 0), reading(200, 50_000, 0, 0, 1)];
    expect(summarizeLatency(flat).currentReadMicros).toBe(0);
  });
});

describe("latencyPoints", () => {
  it("emits one windowed point per consecutive pair, later timestamp", () => {
    const points = latencyPoints(series);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      capturedAt: "2026-07-25T01:00:00Z",
      readMicros: 1000,
      writeMicros: 4000,
    });
    expect(points[1]).toEqual({
      capturedAt: "2026-07-25T02:00:00Z",
      readMicros: 500,
      writeMicros: 7000,
    });
  });
  it("gaps the chart across a counter reset rather than plotting it below zero", () => {
    const points = latencyPoints([reading(13, 36_627, 0, 0, 0), reading(15, 23_020, 0, 0, 1)]);
    expect(points).toHaveLength(1);
    expect(points[0]?.readMicros).toBeNull();
  });

  it("nulls a channel whose ops did not advance", () => {
    const points = latencyPoints([
      reading(100, 100_000, 5, 1000, 0),
      reading(200, 150_000, 5, 1000, 1),
    ]);
    expect(points[0]?.readMicros).toBe(500);
    expect(points[0]?.writeMicros).toBeNull();
  });
});
