import { describe, expect, it } from "vitest";
import type { IndexSpec } from "./types";
import {
  esrKeys,
  type QueryShape,
  recommendCreates,
  recommendNarrowing,
  type SortKey,
  sortOrderAdvisories,
} from "./workload";

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
    partialFilter: null,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
  };
}

const options = { minCount: 1 };
const mongosh = { application: "mongosh 2.8.3" };
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

describe("recommendCreates (partial-aware UPDATE and MERGE)", () => {
  const partialIdx = (
    name: string,
    fields: string[],
    filter: Record<string, unknown>,
  ): IndexSpec => ({
    ...idx(name, fields),
    partial: true,
    partialFilter: filter,
  });
  const activeShape = (equality: string[], count = 4): QueryShape => ({
    equality,
    sort: [],
    range: [],
    collscan: true,
    count,
    constants: { status: "active" },
  });

  it("extends a partial index whose filter matches the want", () => {
    const out = recommendCreates(
      [activeShape(["status", "b", "c"])],
      [partialIdx("b_partial", ["b"], { status: "active" })],
      options,
    );
    expect(out[0]?.type).toBe("UPDATE");
    expect(out[0]?.retireIndexes).toEqual(["b_partial"]);
    expect(out[0]?.partialFilter).toEqual({ status: "active" });
  });

  it("merges two partial singles that share the want's filter", () => {
    const out = recommendCreates(
      [activeShape(["status", "a", "b", "c"])],
      [
        partialIdx("b_partial", ["b"], { status: "active" }),
        partialIdx("c_partial", ["c"], { status: "active" }),
      ],
      options,
    );
    expect(out[0]?.type).toBe("MERGE");
    expect([...(out[0]?.retireIndexes ?? [])].sort()).toEqual(["b_partial", "c_partial"]);
    expect(out[0]?.partialFilter).toEqual({ status: "active" });
  });

  it("ignores key order inside the filter expression", () => {
    const shape: QueryShape = {
      equality: ["status", "region", "b", "c"],
      sort: [],
      range: [],
      collscan: true,
      count: 4,
      constants: { status: "active", region: "eu" },
    };
    const out = recommendCreates(
      [shape],
      [partialIdx("b_partial", ["b"], { region: "eu", status: "active" })],
      options,
    );
    expect(out[0]?.type).toBe("UPDATE");
  });

  it("will not fold a DIFFERENT filter, or a full index, into a partial want", () => {
    const other = recommendCreates(
      [activeShape(["status", "b", "c"])],
      [partialIdx("b_partial", ["b"], { status: "archived" })],
      options,
    );
    expect(other[0]?.type).toBe("CREATE");
    expect(other[0]?.retireIndexes).toEqual([]);

    const full = recommendCreates(
      [activeShape(["status", "b", "c"])],
      [idx("b_1", ["b"])],
      options,
    );
    expect(full[0]?.type).toBe("CREATE");
    expect(full[0]?.retireIndexes).toEqual([]);
  });

  it("will not fold a partial index into a FULL want either", () => {
    const out = recommendCreates(
      [shape(["b", "c"], [], [], 4)],
      [partialIdx("b_partial", ["b"], { status: "active" })],
      options,
    );
    expect(out[0]?.type).toBe("CREATE");
    expect(out[0]?.retireIndexes).toEqual([]);
  });
});

// A query that reaches its documents through an index and then sorts them in
// memory. `collscan` is false — keys were examined — so before this the shape
// was invisible to the create side, however often it ran.
function sortingShape(equality: string[], sort: SortKey[], count = 5): QueryShape {
  return { equality, sort, range: [], collscan: false, sortedInMemory: true, count };
}

describe("recommendCreates (in-memory sorts)", () => {
  it("extends the index that found the documents so it can order them too", () => {
    const out = recommendCreates([sortingShape(["a"], [atDesc])], [idx("a_1", ["a"])], options);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("UPDATE");
    expect(out[0]?.keys).toEqual([
      { field: "a", direction: 1 },
      { field: "at", direction: -1 },
    ]);
    expect(out[0]?.retireIndexes).toEqual(["a_1"]);
    expect(out[0]?.rationale).toContain("in-memory sort seen 5×");
    expect(out[0]?.scanning).toBe(false);
  });

  it("still ignores a shape that neither scans nor sorts", () => {
    const healthy: QueryShape = { equality: ["a"], sort: [], range: [], collscan: false, count: 9 };
    expect(recommendCreates([healthy], [], options)).toHaveLength(0);
  });

  it("marks the candidate as scanning when any shape behind it scans", () => {
    // Same wanted keys from two shapes: one sorts in memory, one scans.
    const out = recommendCreates(
      [sortingShape(["a"], [atDesc]), shape(["a"], [atDesc], [], 3)],
      [],
      options,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.scanning).toBe(true);
    expect(out[0]?.rationale).toContain("collection scan");
  });

  it("carries scanning through consolidation into the wider index", () => {
    // {a} scans, {a,b} only sorts — the surviving wider want inherits the scan.
    const out = recommendCreates(
      [shape(["a"], [], [], 4), sortingShape(["a"], [bAsc], 4)],
      [],
      options,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.keys).toHaveLength(2);
    expect(out[0]?.scanning).toBe(true);
  });

  it("does not propose a duplicate when an index already covers the fields", () => {
    // The directions cannot serve the sort, but a second index differing only
    // in direction is a bigger call than the engine makes unasked.
    expect(
      recommendCreates([sortingShape(["a"], [bAsc])], [idx("ab", ["a", "b"])], options),
    ).toHaveLength(0);
  });
});

// The fields are indexed, but in an order that cannot serve the sort — so the
// server sorts in memory and no create is proposed, because the fix is a second
// index differing only in direction. Silently dropping that was a real finding
// going unreported.
describe("sortOrderAdvisories", () => {
  function directedIdx(name: string, keys: SortKey[]): IndexSpec {
    return { ...idx(name, []), name, keys };
  }

  it("names the index whose direction cannot serve the sort", () => {
    const shape: QueryShape = {
      equality: ["a"],
      sort: [{ field: "b", direction: -1 }],
      range: [],
      collscan: false,
      sortedInMemory: true,
      count: 6,
    };
    const out = sortOrderAdvisories(
      [shape],
      [
        directedIdx("a_1_b_1", [
          { field: "a", direction: 1 },
          { field: "b", direction: 1 },
        ]),
      ],
      options,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.existingIndex).toBe("a_1_b_1");
    expect(out[0]?.wantedKeys).toEqual([
      { field: "a", direction: 1 },
      { field: "b", direction: -1 },
    ]);
    expect(out[0]?.count).toBe(6);
  });

  // A backward scan reverses every key at once, so an all-opposite index does
  // serve the sort and there is nothing to report.
  it("says nothing when a backward scan already serves the sort", () => {
    const shape: QueryShape = {
      equality: [],
      sort: [
        { field: "a", direction: -1 },
        { field: "b", direction: -1 },
      ],
      range: [],
      collscan: false,
      sortedInMemory: true,
      count: 6,
    };
    expect(
      sortOrderAdvisories(
        [shape],
        [
          directedIdx("a_1_b_1", [
            { field: "a", direction: 1 },
            { field: "b", direction: 1 },
          ]),
        ],
        options,
      ),
    ).toHaveLength(0);
  });

  it("says nothing when no index covers the fields — that is a create, not an advisory", () => {
    const shape: QueryShape = {
      equality: ["a"],
      sort: [{ field: "b", direction: -1 }],
      range: [],
      collscan: false,
      sortedInMemory: true,
      count: 6,
    };
    expect(sortOrderAdvisories([shape], [idx("a_1", ["a"])], options)).toHaveLength(0);
  });

  it("ignores a shape that is scanning rather than sorting in memory", () => {
    expect(sortOrderAdvisories([shape(["a"], [atDesc], [], 9)], [], options)).toHaveLength(0);
  });
});

describe("recommendNarrowing", () => {
  const wide = idx("a_1_b_1_c_1", ["a", "b", "c"]);

  it("drops trailing keys no observed query mentions", () => {
    const out = recommendNarrowing([shape(["a"], [bAsc], [], 40)], [wide], options);
    expect(out).toHaveLength(1);
    expect(out[0]?.indexName).toBe("a_1_b_1_c_1");
    expect(out[0]?.keys).toEqual([
      { field: "a", direction: 1 },
      { field: "b", direction: 1 },
    ]);
    expect(out[0]?.droppedKeys).toEqual(["c"]);
    expect(out[0]?.observedCount).toBe(40);
  });

  // The reason this is not a prefix-depth rule. Equality on `a` and a range on
  // `c` matches the index prefix only at position 0, but mongo still applies
  // the `c` bound inside the index — the key is working.
  it("keeps a trailing key a query mentions out of prefix order", () => {
    expect(recommendNarrowing([shape(["a"], [], ["c"], 40)], [wide], options)).toHaveLength(0);
  });

  // A hole in the middle stays: `b` has to be there for `c` to be reachable.
  it("never removes a middle key", () => {
    const out = recommendNarrowing(
      [shape(["a"], [], ["c"], 40)],
      [idx("abcd", ["a", "b", "c", "d"])],
      options,
    );
    expect(out[0]?.keys.map((key) => key.field)).toEqual(["a", "b", "c"]);
    expect(out[0]?.droppedKeys).toEqual(["d"]);
  });

  it("says nothing when no shape reaches the index", () => {
    expect(recommendNarrowing([shape(["z"], [], [], 90)], [wide], options)).toHaveLength(0);
  });

  // An index nothing touches is a DROP_UNUSED, decided from usage history over
  // weeks — far better evidence than a workload sample.
  it("says nothing on an empty workload", () => {
    expect(recommendNarrowing([], [wide], options)).toHaveLength(0);
  });

  it("ignores shapes below minCount", () => {
    const rare = shape(["a"], [bAsc], [], 1);
    expect(recommendNarrowing([rare], [wide], { minCount: 3 })).toHaveLength(0);
  });

  // Shell traffic cannot justify narrowing on its own...
  it("does not narrow on interactive traffic alone", () => {
    const shell: QueryShape = { ...shape(["a"], [bAsc], [], 40), clients: [mongosh] };
    expect(recommendNarrowing([shell], [wide], options)).toHaveLength(0);
  });

  // ...but it still defends a key. A nightly report run through mongosh looks
  // exactly like a person exploring, and dropping `c` would break it.
  it("lets interactive traffic protect a trailing key", () => {
    const app = shape(["a"], [bAsc], [], 90);
    const shell: QueryShape = { ...shape(["a"], [], ["c"], 30), clients: [mongosh] };
    expect(recommendNarrowing([app], [wide], options)).toHaveLength(1);
    expect(recommendNarrowing([app, shell], [wide], options)).toHaveLength(0);
  });

  it("leaves protected and single-key indexes alone", () => {
    const unique = { ...wide, unique: true };
    expect(recommendNarrowing([shape(["a"], [bAsc], [], 40)], [unique], options)).toHaveLength(0);
    const single = idx("a_1", ["a"]);
    expect(recommendNarrowing([shape(["a"], [], [], 40)], [single], options)).toHaveLength(0);
  });

  it("leaves text and hashed indexes alone", () => {
    const text: IndexSpec = {
      ...wide,
      name: "a_1_body_text",
      keys: [
        { field: "a", direction: 1 },
        { field: "body", direction: "text" },
      ],
    };
    expect(recommendNarrowing([shape(["a"], [], [], 40)], [text], options)).toHaveLength(0);
  });

  // Every key earns its place — nothing to propose.
  it("says nothing when the whole index is used", () => {
    const full = shape(["a", "b"], [], ["c"], 40);
    expect(recommendNarrowing([full], [wide], options)).toHaveLength(0);
  });

  it("pools evidence across every shape that reaches the index", () => {
    const out = recommendNarrowing(
      [shape(["a"], [], [], 30), shape(["a"], [bAsc], [], 12), shape(["z"], [], [], 500)],
      [wide],
      options,
    );
    expect(out[0]?.observedCount).toBe(42);
    expect(out[0]?.droppedKeys).toEqual(["c"]);
  });
});
