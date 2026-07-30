import { describe, expect, it } from "vitest";
import { rebuildKeys } from "./rollback";
import type { IndexKey, IndexSpec } from "./types";

function spec(keys: IndexKey[]): IndexSpec {
  return {
    name: "idx",
    keys,
    unique: false,
    ttl: false,
    partial: false,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
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
