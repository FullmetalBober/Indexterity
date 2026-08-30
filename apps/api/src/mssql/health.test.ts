import { describe, expect, it } from "vitest";
import { assessHealth, MSSQL_HEALTH } from "../analysis";
import { stub } from "../test-utils";
import type { MssqlConnection } from "./connection";
import { collectMssqlServerHealth, toServerHealth } from "./health";

// Whatever the counter query returns, as one row. bigint columns arrive from
// tedious as STRINGS, which is the boundary asNumber exists for and the one way
// this mapping could go quietly wrong — a string reaching assessHealth would
// subtract to NaN and read as "counters reset" forever.
function counters(overrides: Record<string, unknown> = {}) {
  return {
    fullScans: "482",
    indexSearches: "150569",
    pageLookups: "5797050",
    workfiles: "252",
    totalMemKb: "774536",
    queuedReaders: 0,
    queuedWriters: 0,
    ...overrides,
  };
}

function stubConn(rows: unknown[] | Error) {
  return stub<MssqlConnection>({
    // Generic, like the real `query<T>`. A mock cannot know T, so the rows it
    // was handed are narrowed to it — the one assertion mocking a generic method
    // needs, and the reason this fake has to declare the shape at all rather
    // than `() => Promise<unknown[]>`, which silently is not the same method.
    query: <T>() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows as T[])),
  });
}

describe("toServerHealth", () => {
  it("maps every counter onto the port, through the string boundary", () => {
    expect(toServerHealth(counters())).toEqual({
      collectionScans: 482,
      scannedKeys: 150569,
      scannedObjects: 5797050,
      scanAndOrder: 252,
      queuedReaders: 0,
      queuedWriters: 0,
      // 774536 KB, reported in MB like mongo's mem.resident.
      residentMb: 756,
    });
  });

  it("is null when the query returned nothing at all", () => {
    expect(toServerHealth(undefined)).toBeNull();
  });

  // A counter this server does not publish comes back as SQL NULL from the
  // conditional aggregate rather than as a missing key. Zero is the honest
  // reading — a counter that is not there did not move — and it keeps the
  // deltas in assessHealth non-negative rather than NaN.
  it("reads an absent counter as zero rather than NaN", () => {
    const health = toServerHealth(counters({ workfiles: null, fullScans: null }));
    expect(health?.scanAndOrder).toBe(0);
    expect(health?.collectionScans).toBe(0);
  });
});

describe("collectMssqlServerHealth", () => {
  it("returns null rather than throwing when VIEW SERVER STATE is withheld", async () => {
    const health = await collectMssqlServerHealth(
      stubConn(new Error("The user does not have permission to perform this action.")),
    );
    expect(health).toBeNull();
  });

  it("reads the first row", async () => {
    const health = await collectMssqlServerHealth(stubConn([counters()]));
    expect(health?.collectionScans).toBe(482);
  });
});

// The thresholds are the half of this that a live server cannot check, because
// what they encode is what a reading MEANS. Each case is one of the measured
// numbers from the probe.
describe("MSSQL_HEALTH against readings taken from a live 2022", () => {
  const at = (over: Partial<ReturnType<typeof toServerHealth>> & object) =>
    ({
      collectionScans: 0,
      scannedObjects: 0,
      scannedKeys: 0,
      scanAndOrder: 0,
      queuedReaders: 0,
      queuedWriters: 0,
      residentMb: 756,
      ...over,
    }) as NonNullable<ReturnType<typeof toServerHealth>>;

  // 3000 seeks moved Index Searches by 3019 and Page lookups by 9076 — a ratio
  // of 3.01, which is just the b-tree descent and does not grow with the table.
  it("calls a seeking workload healthy at 3.01 pages per index search", () => {
    const verdict = assessHealth(
      at({}),
      at({ collectionScans: 300, scannedKeys: 3019, scannedObjects: 9076 }),
      MSSQL_HEALTH,
    );
    expect(verdict.severity).toBe("HEALTHY");
    expect(verdict.indexRelated).toBe(false);
  });

  // 30 full scans of the same table moved Page lookups by 263611 against 3960
  // searches — 66.6 per search, with scanning the dominant cost.
  it("calls a scan-dominated workload elevated at 66.6", () => {
    const verdict = assessHealth(
      at({}),
      at({ collectionScans: 300, scannedKeys: 3960, scannedObjects: 263611 }),
      MSSQL_HEALTH,
    );
    expect(verdict.severity).toBe("ELEVATED");
    expect(verdict.indexRelated).toBe(true);
  });

  // The floor exists because Full Scans counts a three-row lookup table the
  // same as a fact table, and OLTP scans those constantly.
  it("says nothing about a bad ratio under the scan floor", () => {
    const verdict = assessHealth(
      at({}),
      at({ collectionScans: 99, scannedKeys: 10, scannedObjects: 100_000 }),
      MSSQL_HEALTH,
    );
    expect(verdict.severity).toBe("HEALTHY");
  });

  // One deliberately starved 300k-row sort created 3990 workfiles, and every
  // non-spilling loop created none. Mongo's 250 elevated would mean dozens of
  // large spills before anyone looked.
  it("treats a tempdb spill as elevated where mongo's threshold would not fire", () => {
    const spill = assessHealth(at({}), at({ scanAndOrder: 25 }), MSSQL_HEALTH);
    expect(spill.severity).toBe("ELEVATED");
    expect(spill.indexRelated).toBe(true);
    expect(assessHealth(at({}), at({ scanAndOrder: 3990 }), MSSQL_HEALTH).severity).toBe(
      "CRITICAL",
    );
  });

  it("still reports a reader queue, which means the same thing on either engine", () => {
    const verdict = assessHealth(at({}), at({ queuedReaders: 12 }), MSSQL_HEALTH);
    expect(verdict.severity).toBe("CRITICAL");
    // Named for what SQL Server actually makes them wait on — there is no
    // global lock here, and the number comes from the waiting-task DMV.
    expect(verdict.summary).toContain("12 reads waiting on a lock or page latch");
  });

  // The summary is the sentence a human reads, and the first end-to-end run
  // produced "252 collection scans walking 2.7M documents" about page lookups
  // on a 300k-row table. Collection-for-table is a mapping a reader makes;
  // documents-for-pages is a wrong number.
  it("counts pages and table scans rather than documents and collections", () => {
    const verdict = assessHealth(
      at({}),
      at({ collectionScans: 252, scannedKeys: 40_976, scannedObjects: 2_724_161 }),
      MSSQL_HEALTH,
    );
    expect(verdict.summary).toBe("252 table scans walking 2.7M pages");
  });

  it("says a spill is a spill", () => {
    expect(assessHealth(at({}), at({ scanAndOrder: 3990 }), MSSQL_HEALTH).summary).toContain(
      "sorts spilled to tempdb",
    );
  });
});
