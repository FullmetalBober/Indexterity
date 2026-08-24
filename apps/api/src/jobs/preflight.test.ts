import { describe, expect, it } from "vitest";
import type { IndexKey, IndexSpec } from "../engine/types";
import type { IndexCollector } from "../mongo";
import { enforcesTheSame, preflightDrop } from "./preflight";

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

const ASC = index(
  "a_1_b_1",
  [
    { field: "a", direction: 1 },
    { field: "b", direction: 1 },
  ],
  { unique: true },
);

const DESC = index(
  "a_1_b_-1",
  [
    { field: "a", direction: 1 },
    { field: "b", direction: -1 },
  ],
  { unique: true },
);

function collector(specs: IndexSpec[]): IndexCollector {
  return {
    listIndexes: () => Promise.resolve(specs),
    collectUsage: () => Promise.resolve([]),
  } as unknown as IndexCollector;
}

const REORDERED = {
  type: "DROP_REDUNDANT",
  database: "shop",
  collection: "orders",
  indexName: "a_1_b_1",
  targetSpec: { supersededBy: "a_1_b_-1" },
};

// The whole of the re-order feature's safety. Everything else about it is
// sequencing; this is the claim that the replacement enforces what the original
// enforced, and it is checked against LIVE state at the last possible moment.
describe("enforcesTheSame", () => {
  it("accepts a direction-only difference", () => {
    expect(enforcesTheSame(ASC, DESC)).toBe(true);
  });

  // Same constraint, less covered: the replacement forbids exactly what the
  // original forbade and answers fewer queries from its own leaves. The
  // post-build watch is a WRITE-latency gate, so nothing downstream sees it.
  it("refuses a replacement that dropped the original's covering columns", () => {
    const original = index("a_1_b_1", ASC.keys as IndexKey[], {
      unique: true,
      include: ["total"],
    });
    expect(enforcesTheSame(original, DESC)).toBe(false);
    const carried = index("a_1_b_-1", DESC.keys as IndexKey[], {
      unique: true,
      include: ["total"],
    });
    expect(enforcesTheSame(original, carried)).toBe(true);
  });

  it("accepts a replacement that covers MORE than the original", () => {
    const original = index("a_1_b_1", ASC.keys as IndexKey[], { unique: true, include: ["total"] });
    const wider = index("a_1_b_-1", DESC.keys as IndexKey[], {
      unique: true,
      include: ["total", "email"],
    });
    expect(enforcesTheSame(original, wider)).toBe(true);
  });

  it("refuses a different key set", () => {
    const other = index(
      "a_1_c_1",
      [
        { field: "a", direction: 1 },
        { field: "c", direction: 1 },
      ],
      { unique: true },
    );
    expect(enforcesTheSame(ASC, other)).toBe(false);
  });

  it("refuses a different key ORDER — the constraint is the same, the queries are not", () => {
    const swapped = index(
      "b_1_a_1",
      [
        { field: "b", direction: 1 },
        { field: "a", direction: 1 },
      ],
      { unique: true },
    );
    expect(enforcesTheSame(ASC, swapped)).toBe(false);
  });

  // The one outcome the feature must never produce.
  it("refuses a replacement that is not unique", () => {
    expect(enforcesTheSame(ASC, { ...DESC, unique: false })).toBe(false);
  });

  it("refuses a different partial filter, which covers different documents", () => {
    const filtered = { ...DESC, partial: true, partialFilter: { deleted: false } };
    expect(enforcesTheSame(ASC, filtered)).toBe(false);
    expect(
      enforcesTheSame({ ...ASC, partial: true, partialFilter: { deleted: false } }, filtered),
    ).toBe(true);
  });

  it("refuses a different collation, which compares them differently", () => {
    expect(enforcesTheSame(ASC, { ...DESC, collation: "en" })).toBe(false);
  });

  it("refuses a sparse difference, which indexes a different set of documents", () => {
    expect(enforcesTheSame(ASC, { ...DESC, sparse: true })).toBe(false);
  });

  // A hidden index still enforces its constraint but answers no query, and it
  // is the shape a half-finished rollback leaves behind.
  it("refuses a hidden replacement", () => {
    expect(enforcesTheSame(ASC, { ...DESC, hidden: true })).toBe(false);
  });

  it("refuses itself", () => {
    expect(enforcesTheSame(ASC, ASC)).toBe(false);
  });
});

describe("preflightDrop and the protected index", () => {
  it("still refuses a protected index with nothing named as its replacement", async () => {
    const result = await preflightDrop(collector([ASC]), { ...REORDERED, targetSpec: null });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("protected");
  });

  it("allows it when the named replacement is live and matches", async () => {
    const result = await preflightDrop(collector([ASC, DESC]), REORDERED);
    expect(result.safe).toBe(true);
  });

  // The reason this check lives at the last possible moment rather than at
  // proposal time: between the two, somebody can drop the replacement.
  it("refuses when the replacement has gone", async () => {
    const result = await preflightDrop(collector([ASC]), REORDERED);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("not on the cluster");
  });

  it("refuses when the replacement was rebuilt without the constraint", async () => {
    const result = await preflightDrop(collector([ASC, { ...DESC, unique: false }]), REORDERED);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("cannot be assumed to enforce the same rule");
  });

  // The exemption is tied to a named replacement, so it cannot leak into the
  // ordinary redundancy path — which would be a licence to drop any unique
  // index that happened to have a wider one beside it.
  it("does not exempt an ordinary redundant drop of a protected index", async () => {
    const wider = index("a_1_b_1_c_1", [
      { field: "a", direction: 1 },
      { field: "b", direction: 1 },
      { field: "c", direction: 1 },
    ]);
    const result = await preflightDrop(collector([ASC, wider]), {
      type: "DROP_REDUNDANT",
      database: "shop",
      collection: "orders",
      indexName: "a_1_b_1",
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("protected");
  });
});
