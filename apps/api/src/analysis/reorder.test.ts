import { describe, expect, it } from "vitest";
import { isReorderable, orderingPositions, recommendReorder, servesShapeOrder } from "./reorder";
import type { IndexKey, IndexSpec } from "./types";
import type { QueryShape, SortKey } from "./workload";

const OPTIONS = { minCount: 3, minPerWeek: 0.5 };

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

function unique(name: string, keys: IndexKey[], overrides: Partial<IndexSpec> = {}): IndexSpec {
  return index(name, keys, { unique: true, ...overrides });
}

function shape(partial: Partial<QueryShape> = {}): QueryShape {
  return {
    equality: [],
    sort: [],
    range: [],
    collscan: false,
    sortedInMemory: true,
    count: 40,
    ...partial,
  };
}

function keys(pattern: Array<[string, 1 | -1]>): IndexKey[] {
  return pattern.map(([field, direction]) => ({ field, direction }));
}

function pattern(sorted: readonly SortKey[]): Array<[string, 1 | -1]> {
  return sorted.map((key) => [key.field, key.direction]);
}

// The rule the server actually applies, measured on mongod 8.2 rather than
// reasoned about: `{a:1,b:1,c:1}` serves `find({a:1}).sort({b:-1,c:-1})` from
// the index (equality pins `a`, and the rest is a full inversion) and does NOT
// serve `find({}).sort({a:1,b:-1})` (a partial inversion, which no single scan
// direction can produce).
describe("servesShapeOrder", () => {
  const abc = index(
    "abc",
    keys([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]),
  );

  it("serves a sort that matches its directions", () => {
    expect(servesShapeOrder(abc, shape({ sort: [{ field: "a", direction: 1 }] }))).toBe(true);
  });

  it("serves the exact inverse, which is a backward scan", () => {
    const sort: SortKey[] = [
      { field: "a", direction: -1 },
      { field: "b", direction: -1 },
    ];
    expect(servesShapeOrder(abc, shape({ sort }))).toBe(true);
  });

  it("does not serve a partial inversion", () => {
    const sort: SortKey[] = [
      { field: "a", direction: 1 },
      { field: "b", direction: -1 },
    ];
    expect(servesShapeOrder(abc, shape({ sort }))).toBe(false);
  });

  // The distinction that keeps the addressable set honest. An equality
  // predicate pins its field to one value, so the index's direction there
  // constrains nothing — reading the whole key list as an ordering requirement
  // would propose a rebuild that buys the query nothing at all.
  it("ignores the direction of a field an equality predicate pins", () => {
    const pinned = index(
      "abc",
      keys([
        ["a", -1],
        ["b", 1],
        ["c", 1],
      ]),
    );
    const sort: SortKey[] = [
      { field: "b", direction: 1 },
      { field: "c", direction: 1 },
    ];
    expect(servesShapeOrder(pinned, shape({ equality: ["a"], sort }))).toBe(true);
  });

  it("has nothing to say about a shape that does not sort", () => {
    expect(servesShapeOrder(abc, shape({ equality: ["a"], sortedInMemory: false }))).toBe(true);
  });

  it("reports where each ordering requirement lands", () => {
    const sort: SortKey[] = [
      { field: "b", direction: -1 },
      { field: "c", direction: 1 },
    ];
    expect(orderingPositions(shape({ equality: ["a"], sort }))).toEqual([
      { position: 1, direction: -1 },
      { position: 2, direction: 1 },
    ]);
  });
});

// Smaller than "unique indexes", and every exclusion is a fact about MongoDB.
describe("what is addressable at all", () => {
  it("takes a compound unique index", () => {
    expect(
      isReorderable(
        unique(
          "a_1_b_1",
          keys([
            ["a", 1],
            ["b", 1],
          ]),
        ),
      ),
    ).toBe(true);
  });

  // MongoDB walks an index in either direction, so `{a:1}` already serves
  // `sort({a:-1})`. Direction only means something BETWEEN keys — and most
  // unique indexes in the wild are single-field, which is what makes this set
  // small.
  it("refuses a single-field index, which gains nothing", () => {
    expect(isReorderable(unique("email_1", keys([["email", 1]])))).toBe(false);
  });

  it("refuses an index that is not protected at all — the ordinary path has it", () => {
    expect(
      isReorderable(
        index(
          "a_1_b_1",
          keys([
            ["a", 1],
            ["b", 1],
          ]),
        ),
      ),
    ).toBe(false);
  });

  it("refuses a shard key, which can never be dropped", () => {
    const spec = unique(
      "shard",
      keys([
        ["a", 1],
        ["b", 1],
      ]),
      { isShardKey: true },
    );
    expect(isReorderable(spec)).toBe(false);
  });

  it("refuses _id_, which cannot be modified", () => {
    expect(
      isReorderable(
        unique(
          "_id_",
          keys([
            ["_id", 1],
            ["x", 1],
          ]),
        ),
      ),
    ).toBe(false);
  });

  it("refuses TTL, which is single-field in MongoDB and so has no direction to change", () => {
    const spec = unique(
      "ttl",
      keys([
        ["at", 1],
        ["b", 1],
      ]),
      { ttl: true },
    );
    expect(isReorderable(spec)).toBe(false);
  });

  it("refuses a key type that is not ordered", () => {
    const spec = unique("geo", [
      { field: "a", direction: 1 },
      { field: "loc", direction: "2dsphere" },
    ]);
    expect(isReorderable(spec)).toBe(false);
  });
});

describe("recommendReorder", () => {
  const sortAB: SortKey[] = [
    { field: "a", direction: 1 },
    { field: "b", direction: -1 },
  ];

  it("proposes the directions the workload needs, keeping the field order", () => {
    const existing = [
      unique(
        "a_1_b_1",
        keys([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ];
    const [candidate] = recommendReorder([shape({ sort: sortAB })], existing, OPTIONS);
    expect(candidate?.indexName).toBe("a_1_b_1");
    expect(pattern(candidate?.keys ?? [])).toEqual([
      ["a", 1],
      ["b", -1],
    ]);
  });

  // The claim the whole feature rests on, restated where the code can be held
  // to it: the ORIGINAL travels with the candidate so every option can be
  // carried over verbatim. A dropped option is a silently weakened constraint.
  it("carries the original spec so nothing is re-derived", () => {
    const original = unique(
      "a_1_b_1",
      keys([
        ["a", 1],
        ["b", 1],
      ]),
      {
        sparse: true,
        collation: "en",
        partial: true,
        partialFilter: { deleted: false },
      },
    );
    const [candidate] = recommendReorder([shape({ sort: sortAB })], [original], OPTIONS);
    expect(candidate?.spec).toEqual(original);
  });

  it("says the constraint is preserved, and why", () => {
    const existing = [
      unique(
        "a_1_b_1",
        keys([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ];
    const [candidate] = recommendReorder([shape({ sort: sortAB })], existing, OPTIONS);
    expect(candidate?.rationale).toContain("key SET");
    expect(candidate?.rationale).toContain("built FIRST");
  });

  it("says nothing when the directions already serve the sort", () => {
    const existing = [
      unique(
        "a_1_b_-1",
        keys([
          ["a", 1],
          ["b", -1],
        ]),
      ),
    ];
    expect(recommendReorder([shape({ sort: sortAB })], existing, OPTIONS)).toEqual([]);
  });

  it("says nothing for a shape that is not sorting in memory", () => {
    const existing = [
      unique(
        "a_1_b_1",
        keys([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ];
    const notSorting = shape({ sort: sortAB, sortedInMemory: false });
    expect(recommendReorder([notSorting], existing, OPTIONS)).toEqual([]);
  });

  it("says nothing for a shape that has not recurred", () => {
    const existing = [
      unique(
        "a_1_b_1",
        keys([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ];
    const rare = shape({ sort: sortAB, count: 1 });
    expect(recommendReorder([rare], existing, OPTIONS)).toEqual([]);
  });

  it("says nothing when the fields do not line up with the index", () => {
    const existing = [
      unique(
        "a_1_b_1_c_1",
        keys([
          ["a", 1],
          ["b", 1],
          ["c", 1],
        ]),
      ),
    ];
    expect(recommendReorder([shape({ sort: sortAB })], existing, OPTIONS)).toEqual([]);
  });

  // The regression nothing downstream would catch. The post-build watch is a
  // WRITE-latency gate, so a read this flip pushed into an in-memory sort would
  // never be noticed — which makes "which pattern to keep" a judgement about the
  // workload rather than a free improvement, and the engine does not make it.
  it("refuses to flip when another recurring shape relies on the current directions", () => {
    const existing = [
      unique(
        "a_1_b_1",
        keys([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ];
    const served = shape({
      sort: [
        { field: "a", direction: 1 },
        { field: "b", direction: 1 },
      ],
      sortedInMemory: false,
      count: 90,
    });
    expect(recommendReorder([shape({ sort: sortAB }), served], existing, OPTIONS)).toEqual([]);
  });

  // Two patterns serve any sort — the shape's own and its exact inverse — so
  // the one closer to the index as it stands wins. Here `{a:-1,b:1}` is asked
  // for against an index that is `{a:1,b:-1}`: the inverse of the request is
  // exactly what is already there, so nothing has to change at all.
  it("picks whichever of the two equivalent patterns disturbs the index least", () => {
    const existing = [
      unique(
        "a_1_b_-1",
        keys([
          ["a", 1],
          ["b", -1],
        ]),
      ),
    ];
    const wanted: SortKey[] = [
      { field: "a", direction: -1 },
      { field: "b", direction: 1 },
    ];
    expect(recommendReorder([shape({ sort: wanted })], existing, OPTIONS)).toEqual([]);
  });

  // A hard veto, not a scoring penalty. `.hint("a_1_b_1")` against an index
  // that is now `a_1_b_-1` is an ERROR rather than a slower query, and the
  // default name encodes the directions — so a hint breaks by name as surely as
  // by key pattern, and nothing downstream would notice: the post-build watch
  // measures WRITE latency, and the broken queries would have stopped running.
  it("refuses an index the application pins with hint()", () => {
    const existing = [
      unique(
        "a_1_b_1",
        keys([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ];
    const shapes = [shape({ sort: sortAB })];
    expect(recommendReorder(shapes, existing, OPTIONS)).toHaveLength(1);
    expect(recommendReorder(shapes, existing, OPTIONS, new Set(["a_1_b_1"]))).toEqual([]);
  });

  it("counts every blocked shape behind the candidate", () => {
    const existing = [
      unique(
        "a_1_b_1",
        keys([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ];
    const shapes = [shape({ sort: sortAB, count: 40 }), shape({ sort: sortAB, count: 11 })];
    const [candidate] = recommendReorder(shapes, existing, OPTIONS);
    expect(candidate?.count).toBe(51);
  });
});
