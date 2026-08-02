import { describe, expect, it } from "vitest";
import { readPressure } from "./pressure";

// Cumulative counters: 200 reads averaging 2ms so far.
const baseline = { ops: 200, latencyMicros: 400_000 };

describe("readPressure", () => {
  it("flags reads that got dramatically slower", () => {
    // 100 more reads, but they took 20ms each.
    const verdict = readPressure(baseline, {
      ops: 300,
      latencyMicros: 400_000 + 100 * 20_000,
    });
    expect(verdict.underPressure).toBe(true);
    expect(verdict.reason).toContain("20ms against a 2.0ms baseline");
  });

  it("ignores a collection that is simply busy at its usual speed", () => {
    const verdict = readPressure(baseline, {
      ops: 5000,
      latencyMicros: 400_000 + 4800 * 2000,
    });
    expect(verdict.underPressure).toBe(false);
  });

  it("says nothing about an interval with too few reads to judge", () => {
    const verdict = readPressure(baseline, { ops: 205, latencyMicros: 400_000 + 5 * 90_000 });
    expect(verdict.underPressure).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  // A tripled ratio on sub-millisecond reads is noise, not an incident.
  it("does not cry wolf over fast queries that got slightly less fast", () => {
    const fast = { ops: 1000, latencyMicros: 100_000 }; // 100µs each
    const verdict = readPressure(fast, { ops: 2000, latencyMicros: 100_000 + 1000 * 500 });
    expect(verdict.underPressure).toBe(false);
  });

  it("treats a restarted counter as unknowable, not as an incident", () => {
    const verdict = readPressure(baseline, { ops: 5, latencyMicros: 1000 });
    expect(verdict.underPressure).toBe(false);
    expect(verdict.reason).toBeNull();
  });
});
