import { describe, expect, it } from "vitest";
import { bypassesChangeWindow, scanCost } from "./severity";
import type { QueryShape } from "./workload";

function scan(count: number, docsExamined?: number): QueryShape {
  return { equality: ["a"], sort: [], range: [], collscan: true, count, docsExamined };
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
