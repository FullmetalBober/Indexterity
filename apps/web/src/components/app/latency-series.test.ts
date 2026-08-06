import type { CollectionLatencySeries } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { latencyCharts } from "./latency-series";

const PALETTE = ["#a", "#b", "#c", "#d"];

function series(
  collection: string,
  points: { read: number | null; write: number | null }[],
): CollectionLatencySeries {
  return {
    database: "msb-app",
    collection,
    points: points.map((point, i) => ({
      capturedAt: `2026-08-0${i + 1}T00:00:00Z`,
      readMicros: point.read,
      writeMicros: point.write,
    })),
  };
}

describe("latencyCharts", () => {
  // The bug this module exists for. One shared ranking by total point count took the
  // four collections with the most samples for BOTH charts, so on a read-heavy
  // cluster the write chart got four all-null series and said "Not enough samples
  // yet" — while a collection on the same cluster had real write data.
  it("ranks each chart by the metric it actually draws", () => {
    const collections = [
      // Most samples on the cluster, and never written to. Under the old ranking this
      // filled every write slot.
      series("read-heavy", [
        { read: 100, write: null },
        { read: 110, write: null },
        { read: 120, write: null },
        { read: 130, write: null },
      ]),
      series("also-read-heavy", [
        { read: 200, write: null },
        { read: 210, write: null },
        { read: 220, write: null },
      ]),
      series("third-read", [
        { read: 300, write: null },
        { read: 310, write: null },
      ]),
      series("fourth-read", [
        { read: 400, write: null },
        { read: 410, write: null },
      ]),
      // Fewest samples, and the only one with writes.
      series("written-to", [{ read: null, write: 900 }]),
    ];

    const { readSeries, writeSeries } = latencyCharts(collections, PALETTE);

    expect(readSeries.map((s) => s.label)).toEqual([
      "msb-app.read-heavy",
      "msb-app.also-read-heavy",
      "msb-app.fourth-read",
      "msb-app.third-read",
    ]);
    // The whole point: the write chart shows the collection that has writes, however
    // few samples it has, instead of four empty series.
    expect(writeSeries.map((s) => s.label)).toEqual(["msb-app.written-to"]);
  });

  it("leaves a chart empty only when nothing anywhere has that metric", () => {
    const { readSeries, writeSeries } = latencyCharts(
      [series("reads-only", [{ read: 100, write: null }])],
      PALETTE,
    );
    expect(readSeries).toHaveLength(1);
    expect(writeSeries).toHaveLength(0);
  });

  it("gives a collection the same colour on both charts", () => {
    const collections = [
      series("both", [
        { read: 10, write: 20 },
        { read: 11, write: 21 },
      ]),
      series("reads", [{ read: 30, write: null }]),
      series("writes", [{ read: null, write: 40 }]),
    ];
    const { readSeries, writeSeries } = latencyCharts(collections, PALETTE);
    const readColor = readSeries.find((s) => s.label === "msb-app.both")?.color;
    const writeColor = writeSeries.find((s) => s.label === "msb-app.both")?.color;
    expect(readColor).toBe(writeColor);
    // And two different collections never share one, which is what the colour is for.
    const used = [...readSeries, ...writeSeries].map((s) => `${s.label}:${s.color}`);
    expect(new Set(used.map((entry) => entry.split(":")[1])).size).toBe(3);
  });

  it("counts only the collections that reached neither chart", () => {
    const collections = [
      series("charted-read", [{ read: 1, write: null }]),
      series("charted-write", [{ read: null, write: 2 }]),
      // No drawable point of either kind — a run with no ops through it.
      series("silent", [{ read: null, write: null }]),
    ];
    expect(latencyCharts(collections, PALETTE).foldedCount).toBe(1);
  });

  it("never claims more collections are folded than exist", () => {
    expect(latencyCharts([], PALETTE).foldedCount).toBe(0);
  });

  it("recycles the palette rather than handing out undefined", () => {
    // Both charts full and disjoint is more collections than the palette has slots.
    const collections = Array.from({ length: 8 }, (_, i) =>
      series(`c${i}`, [i % 2 === 0 ? { read: i + 1, write: null } : { read: null, write: i + 1 }]),
    );
    const { readSeries, writeSeries } = latencyCharts(collections, PALETTE);
    for (const entry of [...readSeries, ...writeSeries]) {
      expect(entry.color).toMatch(/^#/);
    }
  });
});
