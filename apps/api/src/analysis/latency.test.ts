import { describe, expect, it } from "vitest";
import {
  chartableCollections,
  type LatencyPoint,
  type LatencyReading,
  latencyGaps,
  latencyPoints,
  summarizeLatency,
} from "./latency";

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

// The bug was never in these deltas: on a replica set the collector read
// $collStats from whichever node the connection's read preference picked, and a
// secondary's write counters sit at zero forever because oplog application is
// not a client write op. Every window was Δops = 0, every point was null, and
// the chart said "not enough samples" about a cluster doing 2,500 writes.
//
// The collector now sums every member (mongo/collector.ts). What is left for
// this layer is saying WHICH kind of nothing a null series is, so the two are
// never confused again.
describe("latencyGaps", () => {
  it("reports nothing to explain once a metric has one drawable window", () => {
    expect(latencyGaps(series)).toEqual({ read: null, write: null });
  });

  it("names the second collect a lone reading is waiting for", () => {
    expect(latencyGaps([reading(100, 100_000, 10, 20_000, 0)])).toEqual({
      read: "AWAITING_SECOND_COLLECT",
      write: "AWAITING_SECOND_COLLECT",
    });
    expect(latencyGaps([])).toEqual({
      read: "AWAITING_SECOND_COLLECT",
      write: "AWAITING_SECOND_COLLECT",
    });
  });

  // The reported shape, and the one that must not read as "no data": reads move,
  // writes never do. Per metric, so a working read chart cannot speak for the
  // write chart beside it.
  it("separates a busy metric from a still one", () => {
    expect(
      latencyGaps([
        reading(100, 100_000, 0, 0, 0),
        reading(200, 200_000, 0, 0, 1),
        reading(300, 260_000, 0, 0, 2),
      ]),
    ).toEqual({ read: null, write: "NO_OPS_RECORDED" });
  });

  // A cumulative total cannot fall while the same mongod runs, so this is a
  // restart — and the window across it is unmeasurable rather than idle.
  it("distinguishes a counter reset from a quiet counter", () => {
    expect(
      latencyGaps([reading(500, 500_000, 400, 800_000, 0), reading(10, 9_000, 5, 9_000, 1)]),
    ).toEqual({ read: "COUNTERS_RESET", write: "COUNTERS_RESET" });
  });

  // One usable window is enough. A restart earlier in the history explains a hole
  // in a series that is otherwise drawing, and the chart is not empty to explain.
  it("stays silent when a reset is followed by real windows", () => {
    expect(
      latencyGaps([
        reading(500, 500_000, 400, 800_000, 0),
        reading(10, 9_000, 5, 9_000, 1),
        reading(60, 39_000, 25, 49_000, 2),
      ]),
    ).toEqual({ read: null, write: null });
  });

  // Micros falling while ops climbs is impossible in the same run of a mongod —
  // it takes a restart that happened to land the op count higher. windowAvg nulls
  // it for exactly that reason, so the gap has to agree.
  it("calls latency going backwards a reset even when ops advanced", () => {
    expect(
      latencyGaps([reading(100, 900_000, 100, 900_000, 0), reading(200, 100_000, 200, 100_000, 1)]),
    ).toEqual({ read: "COUNTERS_RESET", write: "COUNTERS_RESET" });
  });
});

describe("chartableCollections", () => {
  const point = (read: number | null, write: number | null): LatencyPoint => ({
    capturedAt: "2026-08-28T00:00:00.000Z",
    readMicros: read,
    writeMicros: write,
  });
  const series = (collection: string, points: LatencyPoint[]) => ({
    database: "app",
    collection,
    points,
  });
  const names = (chosen: readonly { collection: string }[]) =>
    chosen.map((entry) => entry.collection).sort();

  // The live shape of #85's third outing: every collection read on the same
  // cadence, so every one carries the same point count and the old single
  // ranking was a total tie broken by postgres's row order.
  it("keeps a write-only collection that a tie on point count would have dropped", () => {
    const readers = Array.from({ length: 8 }, (_, i) =>
      series(`reader-${i}`, [point(1, null), point(2, null)]),
    );
    const writer = series("writer", [point(null, 1), point(null, 2)]);
    expect(names(chartableCollections([...readers, writer], 8))).toContain("writer");
  });

  it("splits the budget so neither metric can crowd the other out", () => {
    const readers = Array.from({ length: 6 }, (_, i) =>
      series(`reader-${i}`, [point(i + 1, null)]),
    );
    const writers = Array.from({ length: 6 }, (_, i) =>
      series(`writer-${i}`, [point(null, i + 1)]),
    );
    const chosen = chartableCollections([...readers, ...writers], 8);
    expect(chosen).toHaveLength(8);
    expect(chosen.filter((entry) => entry.collection.startsWith("writer"))).toHaveLength(4);
    expect(chosen.filter((entry) => entry.collection.startsWith("reader"))).toHaveLength(4);
  });

  it("ranks on drawable points, not on how long the collection has been watched", () => {
    const watched = series("watched-longest", [point(null, null), point(null, null), point(1, 1)]);
    const busy = series("busiest", [point(1, 1), point(2, 2)]);
    expect(names(chartableCollections([watched, busy], 2))).toEqual(["busiest", "watched-longest"]);
    // ...and with only one slot per metric, the one with more drawable points wins.
    expect(names(chartableCollections([watched, busy], 2).slice(0, 1))).toEqual(["busiest"]);
  });

  it("breaks ties on namespace so the same cluster charts the same collections", () => {
    const tied = ["zeta", "alpha", "mu"].map((name) => series(name, [point(1, 1)]));
    expect(names(chartableCollections(tied, 2))).toEqual(["alpha", "mu"]);
    expect(names(chartableCollections([...tied].reverse(), 2))).toEqual(["alpha", "mu"]);
  });

  it("still sends collections when neither metric is drawable, so the gap can be explained", () => {
    // A cluster on its first collect: one reading, no window, nothing to draw.
    // An empty payload here leaves the panel with no readGap to read and it
    // falls back to "not enough samples yet", which is the #85 wording.
    const fresh = Array.from({ length: 3 }, (_, i) => series(`c${i}`, [point(null, null)]));
    expect(chartableCollections(fresh, 8)).toHaveLength(3);
  });

  it("never sends more than the cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => series(`c${i}`, [point(i, i)]));
    expect(chartableCollections(many, 8)).toHaveLength(8);
  });
});
