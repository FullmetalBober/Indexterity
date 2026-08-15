import { describe, expect, it } from "vitest";
import { type PurgePattern, purgeAdvisory, purgeIsSupported } from "./purge";
import type { IndexKey, IndexSpec } from "./types";

function index(name: string, keys: IndexKey[], overrides: Partial<IndexSpec> = {}): IndexSpec {
  return {
    name,
    keys,
    unique: false,
    ttl: false,
    partial: false,
    partialFilter: null,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
    ...overrides,
  };
}

const created: IndexKey = { field: "created_at", direction: 1 };
const other: IndexKey = { field: "customer_id", direction: 1 };

const NINETY_DAYS = 90 * 86_400;
const pattern: PurgePattern = {
  field: "created_at",
  count: 5,
  medianRetentionSeconds: NINETY_DAYS,
};

describe("purgeIsSupported", () => {
  it("wants the predicate as the LEADING key — a purge filters on nothing else", () => {
    expect(purgeIsSupported("created_at", [index("ix", [created, other])])).toBe(true);
    expect(purgeIsSupported("created_at", [index("ix", [other, created])])).toBe(false);
  });

  // Our own drop pipeline hides an index for the whole observe window, and a
  // hidden index serves no seek — so a purge is unsupported while it is parked.
  it("does not count a hidden index", () => {
    expect(purgeIsSupported("created_at", [index("ix", [created], { hidden: true })])).toBe(false);
  });
});

describe("purgeAdvisory on mongo", () => {
  it("recommends the TTL index, with the caution that it deletes data", () => {
    const advisory = purgeAdvisory("MONGODB", pattern, "events", [], 1000);
    expect(advisory?.indexName).toBe("created_at_1_ttl");
    expect(advisory?.rationale).toContain("expireAfterSeconds: 7776000");
    expect(advisory?.rationale).toContain("retention ≈ 90 days");
    expect(advisory?.rationale).toContain("never builds TTL indexes");
  });

  it("says nothing once a TTL index is on the field", () => {
    const ttl = index("created_at_1", [created], { ttl: true });
    expect(purgeAdvisory("MONGODB", pattern, "events", [ttl], 1000)).toBeNull();
  });
});

describe("purgeAdvisory on SQL Server", () => {
  // The whole point of the issue: the signal maps and the recommendation does
  // not, because there is no TTL index to recommend.
  it("never mentions a TTL index", () => {
    const advisory = purgeAdvisory("MSSQL", pattern, "dbo.events", [], 1000);
    expect(advisory?.rationale).not.toContain("TTL index would");
    expect(advisory?.rationale).not.toContain("expireAfterSeconds");
    expect(advisory?.rationale).toContain("SQL Server has no TTL index");
  });

  // The case the issue names: the purge that locks a table every night.
  it("recommends the supporting index when the predicate is unindexed", () => {
    const advisory = purgeAdvisory("MSSQL", pattern, "dbo.events", [index("pk", [other])], 1000);
    expect(advisory?.indexName).toBe("created_at_1_purge");
    expect(advisory?.rationale).toContain("SCANS dbo.events");
    expect(advisory?.rationale).toContain("nonclustered index on (created_at)");
  });

  it("says the purge already seeks when the index is there", () => {
    const advisory = purgeAdvisory(
      "MSSQL",
      pattern,
      "dbo.events",
      [index("ix_created", [created])],
      20_000_000,
    );
    expect(advisory?.rationale).toContain("already indexed");
    expect(advisory?.rationale).not.toContain("SCANS");
  });

  // Indexed AND small: the job is doing the right thing and partitioning would
  // be over-engineering. Nothing left to say beats saying something anyway.
  it("stays silent on a small table whose purge is already indexed", () => {
    expect(
      purgeAdvisory("MSSQL", pattern, "dbo.events", [index("ix_created", [created])], 1000),
    ).toBeNull();
  });

  it("names the sliding window as the real answer above ten million rows", () => {
    const advisory = purgeAdvisory("MSSQL", pattern, "dbo.events", [], 20_000_000);
    expect(advisory?.rationale).toContain("SLIDING WINDOW");
    expect(advisory?.rationale).toContain("20M rows");
  });

  it("mentions partitioning only as a someday on a small table", () => {
    const advisory = purgeAdvisory("MSSQL", pattern, "dbo.events", [], 1000);
    expect(advisory?.rationale).toContain("If this table grows");
    expect(advisory?.rationale).not.toContain("SLIDING WINDOW");
  });

  it("is advisory on its face, so nobody reads it as something that will happen", () => {
    const advisory = purgeAdvisory("MSSQL", pattern, "dbo.events", [], 20_000_000);
    expect(advisory?.rationale).toContain("never changes a table's partitioning");
  });

  // The parameterised dialect, which carries no cutoff. Rendering a missing
  // number as "≈ 1 day" would be a confident wrong statement about how long
  // somebody keeps their data.
  it("admits it cannot see the window rather than inventing one", () => {
    const advisory = purgeAdvisory(
      "MSSQL",
      { field: "created_at", count: 5, medianRetentionSeconds: null },
      "dbo.events",
      [],
      1000,
    );
    expect(advisory?.rationale).toContain("not visible in the plan");
    expect(advisory?.rationale).not.toContain("retention ≈");
  });
});
