import { describe, expect, it } from "vitest";
import type { IndexSpec } from "./types";
import { esrKeys, type QueryShape, recommendCreates, type SortKey } from "./workload";

function shape(equality: string[], sort: SortKey[], range: string[], count = 1): QueryShape {
  return { equality, sort, range, collscan: true, count };
}

function idx(name: string, fields: string[]): IndexSpec {
  return {
    name,
    keys: fields.map((field) => ({ field, direction: 1 })),
    unique: false,
    ttl: false,
    partial: false,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
  };
}

const options = { minCount: 1 };
const atDesc: SortKey = { field: "at", direction: -1 };
const bAsc: SortKey = { field: "b", direction: 1 };

describe("esrKeys", () => {
  it("orders equality → sort → range, dedupes, keeps sort directions", () => {
    expect(esrKeys(shape(["a"], [atDesc], ["a", "c"]))).toEqual([
      { field: "a", direction: 1 },
      { field: "at", direction: -1 },
      { field: "c", direction: 1 },
    ]);
  });
});

describe("recommendCreates (ESR)", () => {
  it("CREATE with ESR-ordered directed keys", () => {
    const out = recommendCreates([shape(["a"], [atDesc], ["c"])], [], options);
    expect(out[0]?.type).toBe("CREATE");
    expect(out[0]?.keys).toEqual([
      { field: "a", direction: 1 },
      { field: "at", direction: -1 },
      { field: "c", direction: 1 },
    ]);
    expect(out[0]?.count).toBe(1);
  });

  it("UPDATE extends an existing prefix index", () => {
    const out = recommendCreates([shape(["a"], [], ["b"])], [idx("a_1", ["a"])], options);
    expect(out[0]?.type).toBe("UPDATE");
    expect(out[0]?.retireIndexes).toEqual(["a_1"]);
    expect(out[0]?.keys.map((key) => key.field)).toEqual(["a", "b"]);
  });

  it("MERGE replaces single-field indexes when none is a usable prefix", () => {
    const out = recommendCreates(
      [shape(["a", "b", "c"], [], [])],
      [idx("b_1", ["b"]), idx("c_1", ["c"])],
      options,
    );
    expect(out[0]?.type).toBe("MERGE");
    expect([...(out[0]?.retireIndexes ?? [])].sort()).toEqual(["b_1", "c_1"]);
  });

  it("skips a shape already served by an equal index (field-name match)", () => {
    const out = recommendCreates([shape(["a"], [bAsc], [])], [idx("ab", ["a", "b"])], options);
    expect(out).toHaveLength(0);
  });

  it("moves constant equality predicates into a partial filter", () => {
    const withConstants: QueryShape = {
      equality: ["status", "region"],
      sort: [atDesc],
      range: [],
      collscan: true,
      count: 5,
      constants: { status: "active" },
    };
    const out = recommendCreates([withConstants], [], options);
    expect(out[0]?.partialFilter).toEqual({ status: "active" });
    expect(out[0]?.keys.map((key) => key.field)).toEqual(["region", "at"]);
    expect(out[0]?.rationale).toContain('status = "active"');
  });

  it("keeps a normal candidate when constants would leave no keys", () => {
    const allConstant: QueryShape = {
      equality: ["status"],
      sort: [],
      range: [],
      collscan: true,
      count: 3,
      constants: { status: "active" },
    };
    const out = recommendCreates([allConstant], [], options);
    expect(out[0]?.partialFilter).toBeUndefined();
    expect(out[0]?.keys.map((key) => key.field)).toEqual(["status"]);
  });

  it("ignores non-collscan or below-count shapes", () => {
    const notScanning: QueryShape = {
      equality: ["a"],
      sort: [],
      range: [],
      collscan: false,
      count: 9,
    };
    expect(recommendCreates([notScanning], [], options)).toHaveLength(0);
    expect(recommendCreates([shape(["a"], [], [], 0)], [], options)).toHaveLength(0);
  });
});

describe("recommendCreates (consolidation)", () => {
  it("folds a prefix want into the widest covering want, summing counts", () => {
    const out = recommendCreates(
      [shape(["a"], [], [], 5), shape(["a", "b"], [], [], 3), shape(["a", "b", "c"], [], [], 2)],
      [],
      options,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.keys.map((key) => key.field)).toEqual(["a", "b", "c"]);
    expect(out[0]?.count).toBe(10);
    expect(out[0]?.rationale).toContain("2 narrower shapes");
  });

  it("does not consolidate across mismatched directions", () => {
    const out = recommendCreates(
      [shape([], [bAsc], [], 5), shape([], [{ field: "b", direction: -1 }, atDesc], [], 3)],
      [],
      options,
    );
    expect(out).toHaveLength(2);
  });

  // The filter is only carried by the CREATE branch. A partial want that fell
  // into UPDATE or MERGE used to lose it silently and widen a full index —
  // the opposite of the narrowing the analysis had just decided on.
  it("keeps a partial want a partial CREATE even when an index could be extended", () => {
    // status is constant, so the want narrows to {b, c} plus a filter — and
    // the existing b_1 is a proper prefix of that, which is exactly the shape
    // that used to be turned into a full UPDATE.
    const partialShape: QueryShape = {
      equality: ["status", "b", "c"],
      sort: [],
      range: [],
      collscan: true,
      count: 4,
      constants: { status: "active" },
    };
    const out = recommendCreates([partialShape], [idx("b_1", ["b"])], options);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("CREATE");
    expect(out[0]?.partialFilter).toEqual({ status: "active" });
    // The full index is left alone — it may be serving the documents the
    // filter excludes.
    expect(out[0]?.retireIndexes).toEqual([]);
  });

  it("never consolidates into or out of partial candidates", () => {
    const partialShape: QueryShape = {
      equality: ["status", "b"],
      sort: [],
      range: [],
      collscan: true,
      count: 4,
      constants: { status: "active" },
    };
    // The partial candidate indexes {b} only; the {b, at} want must survive.
    const out = recommendCreates([partialShape, shape(["b"], [atDesc], [], 2)], [], options);
    expect(out).toHaveLength(2);
  });
});
