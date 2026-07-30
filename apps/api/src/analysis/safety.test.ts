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
  it("protects partial", () => expect(isNeverDrop(spec({ partial: true }))).toBe(true));
  it("protects sparse", () => expect(isNeverDrop(spec({ sparse: true }))).toBe(true));
  it("allows a plain secondary index", () => expect(isNeverDrop(spec())).toBe(false));
});
