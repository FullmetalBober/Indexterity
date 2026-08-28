import { describe, expect, it } from "vitest";
import type { LatencyReading } from "./latency";
import {
  OBSERVE_WALLCLOCK_MULTIPLE,
  observationCanFinish,
  observedWindow,
  outstayedWindow,
} from "./observed";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const OPTIONS = { factor: 1.5, minWindowOps: 20 };
const START = Date.UTC(2026, 7, 1);

// Cumulative readings an hour apart, each adding `ops` reads at `micros` each.
// `resetAt` restarts the counters before that index, as a mongod restart does.
function readings(
  count: number,
  ops: number,
  micros: number,
  from = START,
  resetAt = -1,
): LatencyReading[] {
  const out: LatencyReading[] = [];
  let cumulativeOps = 1000;
  let cumulativeMicros = 1000 * 100;
  for (let i = 0; i < count; i++) {
    if (i === resetAt) {
      cumulativeOps = 0;
      cumulativeMicros = 0;
    }
    const at = new Date(from + i * HOUR).toISOString();
    out.push({
      capturedAt: at,
      lastSeenAt: at,
      observations: 1,
      maxGapMs: 0,
      readOps: cumulativeOps,
      readLatencyMicros: cumulativeMicros,
      writeOps: 0,
      writeLatencyMicros: 0,
    });
    cumulativeOps += ops;
    cumulativeMicros += ops * micros;
  }
  return out;
}

// A day of history before the hide, then `hours` after it, at `afterMicros`/op.
function around(hours: number, beforeMicros: number, afterMicros: number, resetAt = -1) {
  const hiddenAt = START + 24 * HOUR;
  const before = readings(25, 100, beforeMicros);
  const after = readings(hours + 1, 100, afterMicros, hiddenAt, resetAt < 0 ? -1 : resetAt);
  return { hiddenAt, all: [...before, ...after] };
}

describe("observedWindow", () => {
  it("counts observation in measured windows, not in elapsed wall clock", () => {
    const { hiddenAt, all } = around(48, 100, 100);
    const observed = observedWindow(all, hiddenAt, 1, OPTIONS);
    expect(observed.verdict).toBe("STABLE");
    expect(Math.round(observed.observedMs / HOUR)).toBe(48);
  });

  it("keeps observing while the window is short rather than calling it fine", () => {
    const { hiddenAt, all } = around(6, 100, 100);
    expect(observedWindow(all, hiddenAt, 1, OPTIONS).verdict).toBe("INCOMPLETE");
  });

  it("charges a restart the window it lands in and keeps the rest", () => {
    // 48 hours of observation with a reset 24 in. One window spans it and is
    // dropped; the other 47 stand — where the cumulative gate would have thrown
    // away all 48 and un-hidden the index.
    const { hiddenAt, all } = around(48, 100, 100, 24);
    const observed = observedWindow(all, hiddenAt, 1, OPTIONS);
    expect(Math.round(observed.observedMs / HOUR)).toBe(47);
    expect(observed.verdict).toBe("STABLE");
  });

  it("still reaches a verdict on a history that restarts every day", () => {
    // The cluster the whole change is about. Four days of hourly readings with a
    // reset every 24th, judged against a 3-day window: the resets cost four
    // hours in total and the window fills anyway.
    const hiddenAt = START + 24 * HOUR;
    const before = readings(25, 100, 100);
    const after: LatencyReading[] = [];
    for (let day = 0; day < 4; day++) {
      after.push(...readings(24, 100, 100, hiddenAt + day * DAY, 0));
    }
    const observed = observedWindow([...before, ...after], hiddenAt, 3, OPTIONS);
    expect(observed.verdict).toBe("STABLE");
    expect(observed.observedMs).toBeGreaterThanOrEqual(3 * DAY);
  });

  it("calls the collection regressed when the hidden window is slower", () => {
    const { hiddenAt, all } = around(48, 100, 400);
    const observed = observedWindow(all, hiddenAt, 1, OPTIONS);
    expect(observed.verdict).toBe("REGRESSED");
    expect(observed.ratio).toBeCloseTo(4, 5);
  });

  it("does not call a modest slowdown a regression", () => {
    const observed = observedWindow(around(48, 100, 140).all, START + 24 * HOUR, 1, OPTIONS);
    expect(observed.verdict).toBe("STABLE");
  });

  // The distinction the whole module turns on: "cannot tell" is never spelled
  // the same as "all clear", because the caller drops an index on the difference.
  it("says NO_BASELINE rather than STABLE when nothing precedes the hide", () => {
    const hiddenAt = START;
    const observed = observedWindow(readings(49, 100, 100, hiddenAt), hiddenAt, 1, OPTIONS);
    expect(observed.verdict).toBe("NO_BASELINE");
  });

  it("watches a trickle of traffic without drawing a ratio from it", () => {
    // A handful of reads across the whole window cannot show that hiding an index
    // cost anything — even when each one is slow. The time still counts as
    // watched (we were looking, and nothing was there to hurt), and the verdict
    // is the same "too quiet to have been hurt" the cumulative gate gave.
    const hiddenAt = START + 24 * HOUR;
    const all = [
      ...readings(25, 100, 100),
      // 4 windows × 4 reads = 16 ops, under minWindowOps, at 10x the latency.
      ...readings(5, 4, 1_000, hiddenAt),
    ];
    const observed = observedWindow(all, hiddenAt, 0.15, OPTIONS);
    expect(Math.round(observed.observedMs / HOUR)).toBe(4);
    expect(observed.verdict).toBe("STABLE");
    expect(observed.ratio).toBeNull();
  });

  // A collection nobody queries. An edge case here and the ordinary case on the
  // write side, where most collections take no writes at all.
  it("counts quiet time as observed and calls it stable, not incomplete", () => {
    // Hiding an index cannot have hurt anyone who did not read — the cumulative
    // gate said so by returning a null ratio and STABLE, and this must agree.
    // Counting only busy windows left this INCOMPLETE forever, so the index was
    // un-hidden past the cap and re-proposed: the cycle this module ends,
    // reached from the quiet side instead of the restarting one.
    const hiddenAt = START + 24 * HOUR;
    const all = [...readings(25, 100, 100), ...readings(49, 0, 0, hiddenAt)];
    const observed = observedWindow(all, hiddenAt, 1, OPTIONS);
    expect(Math.round(observed.observedMs / HOUR)).toBe(48);
    expect(observed.verdict).toBe("STABLE");
  });
});

describe("outstayedWindow", () => {
  it("tolerates a window taking longer than the calendar says", () => {
    expect(outstayedWindow(START, 7, START + 20 * DAY)).toBe(false);
  });

  it("gives up past the multiple, so nothing stays hidden indefinitely", () => {
    expect(outstayedWindow(START, 7, START + (7 * OBSERVE_WALLCLOCK_MULTIPLE + 1) * DAY)).toBe(
      true,
    );
  });
});

describe("observationCanFinish", () => {
  it("says yes for a collection that is readable throughout", () => {
    expect(observationCanFinish(readings(72, 100, 100), 7)).toBe(true);
  });

  it("says yes for one restarting nightly, which only slows the window", () => {
    const all: LatencyReading[] = [];
    for (let day = 0; day < 4; day++) all.push(...readings(24, 100, 100, START + day * DAY, 0));
    expect(observationCanFinish(all, 7)).toBe(true);
  });

  it("says no when nothing measurable ever accumulates", () => {
    // Counters that only ever fall: every pair is a reset, no window survives,
    // so the observation could never advance and the drop is never started.
    //
    // A cluster restarting between EVERY collect is messier than this — the
    // readings are unrelated counter runs, so about half the pairs happen to
    // rise and read as windows. Nothing here can tell those apart, and nothing
    // has to: epochs shorter than the collect interval sum to nothing, so the
    // usage gate refuses the index long before a drop is proposed.
    const all = Array.from({ length: 48 }, (_, i) => {
      const at = new Date(START + i * HOUR).toISOString();
      return {
        capturedAt: at,
        lastSeenAt: at,
        observations: 1,
        maxGapMs: 0,
        readOps: 5_000 - i * 100,
        readLatencyMicros: 500_000 - i * 10_000,
        writeOps: 0,
        writeLatencyMicros: 0,
      };
    });
    expect(observationCanFinish(all, 7)).toBe(false);
  });

  // Every other gate on the drop path already asks whether there is enough
  // evidence. Answering it a second time in a different vocabulary is how two
  // guards come to disagree about the same cluster.
  it("does not refuse a collection it has no history for", () => {
    expect(observationCanFinish([], 7)).toBe(true);
  });
});
