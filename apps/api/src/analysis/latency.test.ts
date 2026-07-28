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
  it("nulls a channel whose ops did not advance", () => {
    const points = latencyPoints([
      reading(100, 100_000, 5, 1000, 0),
      reading(200, 150_000, 5, 1000, 1),
    ]);
    expect(points[0]?.readMicros).toBe(500);
    expect(points[0]?.writeMicros).toBeNull();
  });
});
