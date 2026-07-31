import { describe, expect, it } from "vitest";
import { isNeverDrop } from "./safety";
import type { IndexSpec } from "./types";

function spec(overrides: Partial<IndexSpec> = {}): IndexSpec {
  return {
    name: "idx",
    keys: [{ field: "a", direction: 1 }],
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

describe("isNeverDrop", () => {
  it("protects _id_", () => expect(isNeverDrop(spec({ name: "_id_" }))).toBe(true));
  it("protects unique", () => expect(isNeverDrop(spec({ unique: true }))).toBe(true));
  it("protects TTL", () => expect(isNeverDrop(spec({ ttl: true }))).toBe(true));
  it("protects shard-key", () => expect(isNeverDrop(spec({ isShardKey: true }))).toBe(true));
  it("allows a plain secondary index", () => expect(isNeverDrop(spec())).toBe(false));

  // Partial and sparse are droppable: the pipeline hides and measures rather
  // than trusting the counter, so a narrow index proves itself the same way a
  // plain one does.
  it("allows partial and sparse", () => {
    expect(isNeverDrop(spec({ partial: true }))).toBe(false);
    expect(isNeverDrop(spec({ sparse: true }))).toBe(false);
  });

  // But a constraint is a constraint whatever else the index is — dropping one
  // permits duplicates, which no latency gate sees and recreating cannot undo.
  it("still protects a unique partial or sparse index", () => {
    expect(isNeverDrop(spec({ partial: true, partialFilter: null, unique: true }))).toBe(true);
    expect(isNeverDrop(spec({ sparse: true, unique: true }))).toBe(true);
  });
});
