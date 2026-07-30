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
