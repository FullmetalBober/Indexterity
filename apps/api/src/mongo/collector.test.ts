import { describe, expect, it } from "vitest";
import { dateRangeCutoff, equalityConstants, lookupJoins, pipelineShape } from "./collector";

describe("pipelineShape", () => {
  it("extracts equality/range/directed sort from leading $match + $sort", () => {
    const shape = pipelineShape([
      { $match: { status: { $eq: "?string" }, qty: { $gt: "?number" } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$status" } },
    ]);
    expect(shape).toEqual({
      equality: ["status"],
      sort: [{ field: "createdAt", direction: -1 }],
      range: ["qty"],
    });
  });

  it("stops at the first blocking stage", () => {
    const shape = pipelineShape([
      { $match: { a: { $eq: "?number" } } },
      { $lookup: { from: "other" } },
      { $sort: { b: 1 } }, // after $lookup — an index can't serve this
    ]);
    expect(shape).toEqual({ equality: ["a"], sort: [], range: [] });
  });

  it("null when the leading stages give an index nothing", () => {
    expect(pipelineShape([{ $group: { _id: "$x" } }])).toBeNull();
    expect(pipelineShape([])).toBeNull();
  });
});

describe("equalityConstants", () => {
  it("captures direct and $eq literals, flattening $and", () => {
    expect(
      equalityConstants({
        status: "active",
        $and: [{ archived: { $eq: false } }],
        qty: { $gt: 5 },
      }),
    ).toEqual({ status: "active", archived: false });
  });
  it("ignores operators, objects and non-primitives", () => {
    expect(equalityConstants({ qty: { $gt: 1 }, meta: { a: 1 }, tags: { $in: ["x"] } })).toEqual(
      {},
    );
  });
});

describe("dateRangeCutoff", () => {
  const cutoff = new Date("2026-06-01T00:00:00Z");
  it("accepts a single clean $lt/$lte date predicate", () => {
    expect(dateRangeCutoff({ createdAt: { $lt: cutoff } })).toEqual({
      field: "createdAt",
      cutoff,
    });
    expect(dateRangeCutoff({ at: { $lte: cutoff } })).toEqual({ field: "at", cutoff });
  });
  it("rejects multi-field, non-date and non-range deletes", () => {
    expect(dateRangeCutoff({ createdAt: { $lt: cutoff }, status: "x" })).toBeNull();
    expect(dateRangeCutoff({ createdAt: { $lt: "2026-06-01" } })).toBeNull();
    expect(dateRangeCutoff({ _id: "abc" })).toBeNull();
  });
});

describe("lookupJoins", () => {
  it("collects localField/foreignField joins anywhere in the pipeline, deduped", () => {
    const pipeline = [
      { $match: { status: "a" } },
      { $group: { _id: "$x" } },
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "u" } },
      { $lookup: { from: "users", localField: "ownerId", foreignField: "_id", as: "o" } },
      { $lookup: { from: "items", localField: "sku", foreignField: "sku", as: "i" } },
    ];
    expect(lookupJoins(pipeline)).toEqual([
      { from: "users", foreignField: "_id" },
      { from: "items", foreignField: "sku" },
    ]);
  });

  it("ignores pipeline-form lookups without a foreignField", () => {
    expect(lookupJoins([{ $lookup: { from: "users", pipeline: [], as: "u" } }])).toEqual([]);
  });
});
