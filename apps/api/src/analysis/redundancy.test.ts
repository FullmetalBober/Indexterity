import { describe, expect, it } from "vitest";
import { coversIncludes, isRedundantPrefix, servedByBackwardWalk } from "./redundancy";
import type { IndexKey, IndexSpec } from "./types";

function spec(name: string, keys: IndexKey[], overrides: Partial<IndexSpec> = {}): IndexSpec {
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

const x1: IndexKey = { field: "x", direction: 1 };
const y1: IndexKey = { field: "y", direction: 1 };

describe("isRedundantPrefix", () => {
  it("true when candidate is a proper prefix with matching direction", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [x1, y1]))).toBe(true);
  });
  // #207. This asserted `false`, on the reading that opposite directions are
  // different indexes. Both engines disagree, and were asked: with ONLY the
  // wide inverted index present, `ORDER BY x` plans without a Sort — SQL Server
  // 2022 CU26 reports ScanDirection="BACKWARD", mongod 8.2.9 an IXSCAN with
  // direction "backward". So the narrow one was buying nothing.
  it("true when every direction is inverted — the wider index is read backwards", () => {
    const xDesc: IndexKey = { field: "x", direction: -1 };
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [xDesc, y1]))).toBe(true);
  });

  // The half that keeps it honest, and the one case both engines refuse: a
  // requirement that is neither the key pattern nor its full reverse. A
  // two-key prefix whose first direction matches and whose second does not is
  // served by no walk of the wider index — `ORDER BY x, y DESC` sorted on both
  // engines with only `(x ASC, y ASC, z ASC)` present.
  it("false when the directions are mixed rather than uniformly inverted", () => {
    const yDesc: IndexKey = { field: "y", direction: -1 };
    const z1: IndexKey = { field: "z", direction: 1 };
    expect(isRedundantPrefix(spec("a", [x1, yDesc]), spec("abc", [x1, y1, z1]))).toBe(false);
  });

  // Reversal is a property of an ORDER, and these are not orders — nothing
  // walks a hashed or text key backwards to get a different sequence.
  it("false when an unordered key type would have to be 'inverted'", () => {
    const xHashed: IndexKey = { field: "x", direction: "hashed" };
    expect(isRedundantPrefix(spec("a", [xHashed]), spec("ab", [x1, y1]))).toBe(false);
    expect(isRedundantPrefix(spec("a", [xHashed]), spec("ab", [xHashed, y1]))).toBe(true);
  });
  it("false for equal-length keys", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("b", [x1]))).toBe(false);
  });
  it("false when candidate is unique (does more than accelerate reads)", () => {
    expect(isRedundantPrefix(spec("a", [x1], { unique: true }), spec("ab", [x1, y1]))).toBe(false);
  });
  it("false when candidate is partial/sparse/ttl", () => {
    expect(isRedundantPrefix(spec("a", [x1], { partial: true }), spec("ab", [x1, y1]))).toBe(false);
  });

  // The covering index must actually cover: a restricted superset shares the
  // keys but not the documents, so folding the plain index into it would send
  // every query outside that restriction to a collection scan.
  it("false when the covering index is partial (covers only its filter)", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [x1, y1], { partial: true }))).toBe(false);
  });
  it("false when the covering index is sparse (misses documents lacking the field)", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [x1, y1], { sparse: true }))).toBe(false);
  });
  it("false when the covering index is hidden (the planner will not use it)", () => {
    // Reachable through our own pipeline: a drop hides its index for the whole
    // observe window, which would otherwise make every prefix of it look
    // redundant exactly while it can serve nothing.
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [x1, y1], { hidden: true }))).toBe(false);
  });
  it("still folds into a TTL superset — TTL expires documents, it does not skip them", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [x1, y1], { ttl: true }))).toBe(true);
  });
  it("false against itself", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("a", [x1, y1]))).toBe(false);
  });

  it("a prefix under a different collation is not covered", () => {
    expect(isRedundantPrefix(spec("a", [x1], { collation: "en" }), spec("ab", [x1, y1]))).toBe(
      false,
    );
    expect(
      isRedundantPrefix(
        spec("a", [x1], { collation: "en" }),
        spec("ab", [x1, y1], { collation: "en" }),
      ),
    ).toBe(true);
  });

  it("false for equal-length identical keys (mongod forbids creating those)", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("b", [x1]))).toBe(false);
  });

  // A longer key list is not a wider index. Measured on SQL Server 2022 with
  // 200k rows: SELECT SUM(total) WHERE customer_id = 42 took 6 logical reads
  // through (customer_id) INCLUDE (total) and 1124 once it was gone, with
  // (customer_id, status) still there — the prefix rule alone proposes exactly
  // that swap.
  it("false when the wider index does not carry what the prefix covers", () => {
    expect(isRedundantPrefix(spec("a", [x1], { include: ["total"] }), spec("ab", [x1, y1]))).toBe(
      false,
    );
  });

  it("true when the wider index carries the covered columns as includes", () => {
    expect(
      isRedundantPrefix(
        spec("a", [x1], { include: ["total"] }),
        spec("ab", [x1, y1], { include: ["total", "email"] }),
      ),
    ).toBe(true);
  });

  it("true when the wider index carries them as KEYS — a key column is covered too", () => {
    const total1: IndexKey = { field: "total", direction: 1 };
    expect(
      isRedundantPrefix(spec("a", [x1], { include: ["total"] }), spec("ab", [x1, y1, total1])),
    ).toBe(true);
  });

  it("unchanged for the engines that have no includes at all", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [x1, y1], { include: ["z"] }))).toBe(true);
  });
});

describe("servedByBackwardWalk", () => {
  it("separates the reversed case from the key-for-key one, so a finding can say which", () => {
    const xDesc: IndexKey = { field: "x", direction: -1 };
    expect(servedByBackwardWalk(spec("a", [x1]), spec("ab", [xDesc, y1]))).toBe(true);
    expect(servedByBackwardWalk(spec("a", [x1]), spec("ab", [x1, y1]))).toBe(false);
  });
  it("is false when the wider index does not cover the order at all", () => {
    const yDesc: IndexKey = { field: "y", direction: -1 };
    const z1: IndexKey = { field: "z", direction: 1 };
    expect(servedByBackwardWalk(spec("a", [x1, yDesc]), spec("abc", [x1, y1, z1]))).toBe(false);
  });
});

describe("coversIncludes", () => {
  it("is vacuously true without includes, however the absence is spelled", () => {
    expect(coversIncludes(spec("a", [x1]), spec("b", [y1]))).toBe(true);
    expect(coversIncludes(spec("a", [x1], { include: [] }), spec("b", [y1]))).toBe(true);
  });

  it("needs EVERY covered column, not just one", () => {
    const candidate = spec("a", [x1], { include: ["total", "email"] });
    expect(coversIncludes(candidate, spec("b", [x1, y1], { include: ["total"] }))).toBe(false);
    expect(coversIncludes(candidate, spec("b", [x1, y1], { include: ["total", "email"] }))).toBe(
      true,
    );
  });
});
