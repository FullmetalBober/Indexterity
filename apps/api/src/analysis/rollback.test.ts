import { describe, expect, it } from "vitest";
import type { IndexKey, IndexSpec } from "../engine/types";
import { rebuildKeys, rebuildOptions } from "./rollback";

function spec(keys: IndexKey[], overrides: Partial<IndexSpec> = {}): IndexSpec {
  return {
    name: "idx",
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

describe("rebuildKeys", () => {
  it("rebuilds ascending/descending compound keys in order", () => {
    expect(
      rebuildKeys(
        spec([
          { field: "a", direction: 1 },
          { field: "b", direction: -1 },
        ]),
      ),
    ).toEqual({ a: 1, b: -1 });
  });
  it("refuses special key types", () => {
    expect(rebuildKeys(spec([{ field: "loc", direction: "2dsphere" }]))).toBeNull();
  });
  it("refuses an empty key list", () => {
    expect(rebuildKeys(spec([]))).toBeNull();
  });
});

describe("rebuildOptions", () => {
  const a1: IndexKey = { field: "a", direction: 1 };

  it("carries covering columns, so an undo puts back an index that still covers", () => {
    expect(rebuildOptions(spec([a1], { include: ["total"] }))).toEqual({
      name: "idx",
      include: ["total"],
    });
  });

  it("says nothing about includes when the index had none", () => {
    expect(rebuildOptions(spec([a1]))).toEqual({ name: "idx" });
    expect(rebuildOptions(spec([a1], { include: [] }))).toEqual({ name: "idx" });
  });
});
