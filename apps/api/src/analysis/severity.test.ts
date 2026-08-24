import { describe, expect, it } from "vitest";
import type { QueryShape } from "../engine/types";
import {
  bypassesChangeWindow,
  MIN_WEEKLY_DOCS_EXAMINED,
  scanCost,
  weeklyScanCost,
} from "./severity";

function scan(count: number, docsExamined?: number): QueryShape {
  return { equality: ["a"], sort: [], range: [], collscan: true, count, docsExamined };
}

// The same shape, watched for a known window — the denominator that turns a
// running total into a rate.
function over(shape: QueryShape, observedForHours: number): QueryShape {
  return { ...shape, observedForHours };
}

describe("scanCost", () => {
  it("is routine when nothing is scanning", () => {
    const notScanning: QueryShape = { ...scan(100, 50_000_000), collscan: false };
    expect(scanCost(notScanning, 10_000_000).severity).toBe("ROUTINE");
  });

  it("calls a scan critical on total work, not table size", () => {
    // A modest table, but the shape has walked it into the ground.
    const cost = scanCost(scan(20_000, 20_000_000), 5000);
    expect(cost.severity).toBe("CRITICAL");
    expect(cost.summary).toContain("20.0M documents scanned");
  });

  it("calls a single enormous scan critical even when new", () => {
    // Seen three times, but each execution walks half the collection.
    expect(scanCost(scan(3, 3_000_000), 1_000_000).severity).toBe("CRITICAL");
  });

  it("is elevated for a large collection even with no examined count", () => {
    // The profiler path reports no docsExamined; collection size is the fallback.
    const cost = scanCost(scan(10), 250_000);
    expect(cost.severity).toBe("ELEVATED");
    expect(cost.summary).toContain("250k documents");
  });

  it("leaves a small collection routine — the old 10k gate called this critical", () => {
    expect(scanCost(scan(10, 40_000), 20_000).severity).toBe("ROUTINE");
  });

  it("only lets CRITICAL skip the change window", () => {
    expect(bypassesChangeWindow("CRITICAL")).toBe(true);
    expect(bypassesChangeWindow("ELEVATED")).toBe(false);
    expect(bypassesChangeWindow("ROUTINE")).toBe(false);
  });
});

describe("weeklyScanCost", () => {
  it("costs nothing when nothing is scanning", () => {
    const notScanning: QueryShape = { ...over(scan(10_000, 50_000_000), 1), collscan: false };
    expect(weeklyScanCost([notScanning], 10_000_000)).toBe(0);
  });

  it("sees a small collection scanned constantly — the doc-count gate hid it", () => {
    // 900 documents, 500 scans a second for an hour. Under a 1,000-document
    // floor this collection was excluded before its workload was ever read.
    const cost = weeklyScanCost([over(scan(500 * 3600), 1)], 900);
    expect(cost).toBeGreaterThan(MIN_WEEKLY_DOCS_EXAMINED);
  });

  it("sees a big collection scanned rarely for what it is — cheap", () => {
    // A 50,000-row lookup table scanned twice a day: 700k a week, and it used
    // to sail through the doc-count floor on size alone.
    const cost = weeklyScanCost([over(scan(14), 168)], 50_000);
    expect(cost).toBe(700_000);
    expect(cost).toBeLessThan(MIN_WEEKLY_DOCS_EXAMINED);
  });

  it("prefers the reported examined count to the collection-size estimate", () => {
    // 200 executions over a week, but the server walked far less than the whole
    // collection each time — a partial scan, and the estimate would overstate it.
    expect(weeklyScanCost([over(scan(200, 400_000), 168)], 1_000_000)).toBe(400_000);
  });

  it("lets the total stand in for the rate when the window is unmeasurable", () => {
    // No observedForHours: the profiler's ring can be too short to date. The
    // running total is all there is, and it decides rather than reading as zero.
    expect(weeklyScanCost([scan(10, 5_000_000)], 1000)).toBe(5_000_000);
  });

  it("adds up across shapes — a collection scanned many mild ways still costs", () => {
    const shapes = [over(scan(100, 400_000), 168), over(scan(50, 500_000), 168)];
    expect(weeklyScanCost(shapes, 1_000_000)).toBe(900_000);
  });
});
