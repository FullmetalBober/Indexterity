import { describe, expect, it } from "vitest";
import { assessHealth, type ServerHealth } from "./health";

const base: ServerHealth = {
  collectionScans: 1000,
  scannedObjects: 500_000,
  scannedKeys: 400_000,
  scanAndOrder: 10,
  queuedReaders: 0,
  queuedWriters: 0,
  residentMb: 500,
};

// Not named `after` — that reads as a test hook.
const later = (delta: Partial<ServerHealth>): ServerHealth => ({ ...base, ...delta });

describe("assessHealth", () => {
  it("is critical when scans walk thousands of documents per index key", () => {
    const verdict = assessHealth(
      base,
      later({
        collectionScans: 1400,
        scannedObjects: 500_000 + 20_000_000,
        scannedKeys: 400_000 + 5000,
      }),
    );
    expect(verdict.severity).toBe("CRITICAL");
    expect(verdict.indexRelated).toBe(true);
    expect(verdict.summary).toContain("400 collection scans");
  });

  it("is healthy for a busy server reading efficiently through indexes", () => {
    const verdict = assessHealth(
      base,
      later({
        collectionScans: 1060,
        scannedObjects: 500_000 + 200_000,
        scannedKeys: 400_000 + 190_000,
      }),
    );
    expect(verdict.severity).toBe("HEALTHY");
  });

  it("reports queued readers even when an index is not the answer", () => {
    const verdict = assessHealth(base, later({ queuedReaders: 25 }));
    expect(verdict.severity).toBe("CRITICAL");
    // No scanning in the window, so this is contention of some other kind.
    expect(verdict.indexRelated).toBe(false);
    expect(verdict.summary).toContain("25 reads queued");
  });

  it("mentions unindexed sorts, a symptom the query-shape path misses", () => {
    const verdict = assessHealth(
      base,
      later({
        collectionScans: 1200,
        scannedObjects: 500_000 + 9_000_000,
        scannedKeys: 400_000 + 3000,
        scanAndOrder: 10 + 800,
      }),
    );
    expect(verdict.summary).toContain("800 sorts without an index");
  });

  // A query can reach its documents by index and still sort them by hand. No
  // scan counter moves, so before this the server read as perfectly healthy.
  it("flags a sort storm on a server doing no scanning at all", () => {
    const verdict = assessHealth(base, later({ scanAndOrder: 10 + 4000 }));
    expect(verdict.severity).toBe("CRITICAL");
    expect(verdict.indexRelated).toBe(true);
    expect(verdict.summary).toBe("4k sorts without an index");
    expect(verdict.summary).not.toContain("collection scans");
  });

  it("calls a smaller sort burst elevated", () => {
    const verdict = assessHealth(base, later({ scanAndOrder: 10 + 400 }));
    expect(verdict.severity).toBe("ELEVATED");
    expect(verdict.indexRelated).toBe(true);
  });

  it("leaves an ordinary trickle of sorts alone", () => {
    expect(assessHealth(base, later({ scanAndOrder: 10 + 30 })).severity).toBe("HEALTHY");
  });

  it("takes the worse of the two readings", () => {
    // Scanning is merely elevated, sorting is critical.
    const verdict = assessHealth(
      base,
      later({
        collectionScans: 1200,
        scannedObjects: 500_000 + 200_000,
        scannedKeys: 400_000 + 1000,
        scanAndOrder: 10 + 3000,
      }),
    );
    expect(verdict.severity).toBe("CRITICAL");
    expect(verdict.summary).toContain("collection scans");
    expect(verdict.summary).toContain("sorts without an index");
  });

  it("ignores a handful of scans — every server does some", () => {
    const verdict = assessHealth(
      base,
      later({ collectionScans: 1005, scannedObjects: 500_000 + 5_000_000 }),
    );
    expect(verdict.severity).toBe("HEALTHY");
  });

  it("treats a restart between readings as no evidence", () => {
    const verdict = assessHealth(base, later({ collectionScans: 5, scannedObjects: 100 }));
    expect(verdict.severity).toBe("HEALTHY");
    expect(verdict.summary).toBe("counters reset");
  });
});
