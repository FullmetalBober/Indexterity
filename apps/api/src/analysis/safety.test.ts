import { describe, expect, it } from "vitest";
import type { IndexSpec } from "../engine/types";
import { hideBreaksQueries, isNeverDrop } from "./safety";

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

  // Hiding one of these does not slow its query down, it makes the query FAIL
  // (NoQueryExecutionPlans 291, measured on mongod 7.0.39), so the observe window
  // cannot test the drop at all.
  it("protects text and geo indexes", () => {
    expect(isNeverDrop(spec({ keys: [{ field: "name", direction: "text" }] }))).toBe(true);
    expect(isNeverDrop(spec({ keys: [{ field: "loc", direction: "2dsphere" }] }))).toBe(true);
    expect(isNeverDrop(spec({ keys: [{ field: "loc", direction: "2d" }] }))).toBe(true);
  });

  // hashed degrades to a collection scan like any ordinary index, which is exactly
  // the regression the observe gate exists to catch — so it stays droppable.
  it("allows hashed", () =>
    expect(isNeverDrop(spec({ keys: [{ field: "k", direction: "hashed" }] }))).toBe(false));

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

describe("hideBreaksQueries", () => {
  // One such key is enough: a compound index is still the only thing on the
  // collection that can answer the query its special key serves.
  it("is true for a compound index with one text or geo key", () => {
    const compound = spec({
      keys: [
        { field: "tenant", direction: 1 },
        { field: "name", direction: "text" },
      ],
    });
    expect(hideBreaksQueries(compound)).toBe(true);
  });

  it("is false for an index of ordinary and hashed keys", () => {
    expect(hideBreaksQueries(spec())).toBe(false);
    expect(
      hideBreaksQueries(
        spec({
          keys: [
            { field: "a", direction: -1 },
            { field: "k", direction: "hashed" },
          ],
        }),
      ),
    ).toBe(false);
  });
});
