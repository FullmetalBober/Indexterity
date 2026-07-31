import { describe, expect, it } from "vitest";
import { inChangeWindow, inferChangeWindow, type TrafficSample } from "./window";

function atHour(hour: number): Date {
  return new Date(Date.UTC(2026, 6, 30, hour, 30, 0));
}

describe("inChangeWindow", () => {
  it("is always open without a configured window", () => {
    expect(inChangeWindow(atHour(3), null, null)).toBe(true);
    expect(inChangeWindow(atHour(3), 5, null)).toBe(true);
    expect(inChangeWindow(atHour(3), null, 5)).toBe(true);
  });

  it("treats equal bounds as no window", () => {
    expect(inChangeWindow(atHour(3), 7, 7)).toBe(true);
  });

  it("handles a normal daytime window, end-exclusive", () => {
    expect(inChangeWindow(atHour(9), 9, 17)).toBe(true);
    expect(inChangeWindow(atHour(16), 9, 17)).toBe(true);
    expect(inChangeWindow(atHour(17), 9, 17)).toBe(false);
    expect(inChangeWindow(atHour(8), 9, 17)).toBe(false);
  });

  it("wraps midnight (22 -> 4)", () => {
    expect(inChangeWindow(atHour(23), 22, 4)).toBe(true);
    expect(inChangeWindow(atHour(1), 22, 4)).toBe(true);
    expect(inChangeWindow(atHour(4), 22, 4)).toBe(false);
    expect(inChangeWindow(atHour(12), 22, 4)).toBe(false);
  });
});

// Build the sample series a 6h collect cadence produces: cumulative op counters
// captured at 00/06/12/18 UTC, given per-bucket traffic for each interval.
function series(days: number, perBucket: readonly number[], startDay = 1): TrafficSample[] {
  const samples: TrafficSample[] = [];
  let ops = 0;
  for (let day = 0; day < days; day++) {
    for (let bucket = 0; bucket < 4; bucket++) {
      const date = new Date(Date.UTC(2026, 6, startDay + day, bucket * 6, 0, 0));
      samples.push({ capturedAt: date.toISOString(), ops });
      ops += perBucket[bucket] ?? 0;
    }
  }
  return samples;
}

describe("inferChangeWindow", () => {
  it("names the quietest six hours", () => {
    // Busy in the working day, near-idle overnight.
    const inferred = inferChangeWindow(series(5, [50, 800, 1000, 600]));
    expect(inferred?.startHour).toBe(0);
    expect(inferred?.endHour).toBe(6);
    expect(inferred?.reason).toContain("00:00–06:00 UTC");
    expect(inferred?.reason).toContain("quietest");
  });

  it("finds a quiet bucket that is not midnight", () => {
    const inferred = inferChangeWindow(series(5, [900, 1000, 40, 800]));
    expect(inferred?.startHour).toBe(12);
    expect(inferred?.endHour).toBe(18);
  });

  it("stays silent on a flat day rather than inventing a window", () => {
    expect(inferChangeWindow(series(5, [500, 520, 480, 510]))).toBeNull();
  });

  it("stays silent until every bucket has enough observations", () => {
    // Two days is below the three-per-bucket floor.
    expect(inferChangeWindow(series(2, [50, 800, 1000, 600]))).toBeNull();
  });

  it("ignores a restarted counter instead of reading it as quiet", () => {
    const samples = series(5, [50, 800, 1000, 600]);
    // Server restarts mid-series: the counter drops back to zero.
    const reset = samples.map((sample, i) =>
      i > 8 ? { ...sample, ops: sample.ops - 9000 } : sample,
    );
    const inferred = inferChangeWindow(reset);
    expect(inferred?.startHour).toBe(0);
  });

  it("ignores an interval that spans a collection gap", () => {
    const before = series(3, [50, 800, 1000, 600]);
    // Two weeks unreachable, then collection resumes; the bridging interval
    // must not count as one very busy bucket.
    const after = series(3, [50, 800, 1000, 600], 18).map((sample) => ({
      ...sample,
      ops: sample.ops + 500_000,
    }));
    const inferred = inferChangeWindow([...before, ...after]);
    expect(inferred?.startHour).toBe(0);
    expect(inferred?.endHour).toBe(6);
  });

  it("returns null for an empty or single-sample series", () => {
    expect(inferChangeWindow([])).toBeNull();
    expect(inferChangeWindow([{ capturedAt: "2026-07-01T00:00:00Z", ops: 10 }])).toBeNull();
  });
});
