import { describe, expect, it } from "vitest";
import { equalityConstants, pipelineShape } from "./collector";

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
