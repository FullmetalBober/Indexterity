import { describe, expect, it } from "vitest";
import { isRedundantPrefix } from "./redundancy";
import type { IndexKey, IndexSpec } from "./types";

function spec(name: string, keys: IndexKey[], overrides: Partial<IndexSpec> = {}): IndexSpec {
  return {
    name,
    keys,
    unique: false,
    ttl: false,
    partial: false,
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
  it("false when key directions differ", () => {
    const xDesc: IndexKey = { field: "x", direction: -1 };
    expect(isRedundantPrefix(spec("a", [x1]), spec("ab", [xDesc, y1]))).toBe(false);
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
});
