import { describe, expect, it } from "vitest";
import type { IndexSpec } from "./types";
import { esrFields, type QueryShape, recommendCreates } from "./workload";

function shape(equality: string[], sort: string[], range: string[], count = 1): QueryShape {
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

describe("esrFields", () => {
  it("orders equality → sort → range and dedupes", () => {
    expect(esrFields(shape(["a"], ["b"], ["a", "c"]))).toEqual(["a", "b", "c"]);
  });
});

describe("recommendCreates (ESR)", () => {
  it("CREATE with ESR-ordered keys", () => {
    const out = recommendCreates([shape(["a"], ["b"], ["c"])], [], options);
    expect(out[0]?.type).toBe("CREATE");
    expect(out[0]?.keys).toEqual(["a", "b", "c"]);
  });

  it("UPDATE extends an existing prefix index", () => {
    const out = recommendCreates([shape(["a"], [], ["b"])], [idx("a_1", ["a"])], options);
    expect(out[0]?.type).toBe("UPDATE");
    expect(out[0]?.retireIndexes).toEqual(["a_1"]);
    expect(out[0]?.keys).toEqual(["a", "b"]);
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

  it("skips a shape already served by an equal index", () => {
    const out = recommendCreates([shape(["a", "b"], [], [])], [idx("ab", ["a", "b"])], options);
    expect(out).toHaveLength(0);
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
