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
  it("false against itself", () => {
    expect(isRedundantPrefix(spec("a", [x1]), spec("a", [x1, y1]))).toBe(false);
  });
});
