import type { Db, ListCollectionsCursor } from "mongodb";
import { MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { DatabaseInaccessibleError } from "../engine/ports";
import { stub } from "../test-utils";
import {
  dateRangeCutoff,
  equalityConstants,
  lookupJoins,
  MongoIndexCollector,
  pipelineShape,
  sumLatencyStats,
} from "./collector";
import type { MongoConnection } from "./connection";

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

  // The only path by which a customer's own data reaches our database. A value
  // that is not a low-cardinality discriminator is both useless as a partial
  // filter and the one we should not be holding.
  it("refuses document identifiers and long values", () => {
    expect(
      equalityConstants({
        _id: "507f1f77bcf86cd799439011",
        session: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        note: "x".repeat(65),
        status: "active",
      }),
    ).toEqual({ status: "active" });
  });

  it("keeps short values and numbers whatever they look like", () => {
    expect(equalityConstants({ tier: "pro", shard: 7, live: true })).toEqual({
      tier: "pro",
      shard: 7,
      live: true,
    });
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

// $collStats latencyStats is node-local, so collectionLatency asks the primary
// AND every member — and MemberConnections opens a direct connection to every
// host including the one the base connection is already using. Summing the raw
// list would count the primary twice, and the primary is the only node that has
// any writes at all (#85).
describe("sumLatencyStats", () => {
  const doc = (host: string, reads: [number, number], writes: [number, number]) => ({
    host,
    latencyStats: {
      reads: { ops: reads[0], latency: reads[1] },
      writes: { ops: writes[0], latency: writes[1] },
    },
  });

  it("sums the cluster: primary writes, reads from wherever they were served", () => {
    expect(
      sumLatencyStats([
        doc("a:27017", [302, 308_868], [2500, 611_776]),
        doc("b:27017", [410, 489_973], [0, 0]),
        doc("c:27017", [12, 2_135], [0, 0]),
      ]),
    ).toEqual({
      reads: { ops: 724, latencyMicros: 800_976 },
      writes: { ops: 2500, latencyMicros: 611_776 },
    });
  });

  it("counts a host once however many connections reached it", () => {
    const primary = doc("a:27017", [302, 308_868], [2500, 611_776]);
    expect(sumLatencyStats([primary, primary, doc("b:27017", [410, 489_973], [0, 0])])).toEqual({
      reads: { ops: 712, latencyMicros: 798_841 },
      writes: { ops: 2500, latencyMicros: 611_776 },
    });
  });

  // Two readings of one counter seconds apart. The later is no less true, and
  // taking it keeps the totals monotonic, which is what the delta layer needs.
  it("keeps the newest reading of a host it saw twice", () => {
    expect(
      sumLatencyStats([doc("a:27017", [1, 10], [1, 10]), doc("a:27017", [5, 50], [5, 50])]),
    ).toEqual({ reads: { ops: 5, latencyMicros: 50 }, writes: { ops: 5, latencyMicros: 50 } });
  });

  it("is zero rather than undefined when nothing answered", () => {
    expect(sumLatencyStats([])).toEqual({
      reads: { ops: 0, latencyMicros: 0 },
      writes: { ops: 0, latencyMicros: 0 },
    });
  });
});

// A database the credentials can see and cannot read (#345). The shape that
// reaches it: a connection string holding the cluster `listDatabases` action
// without per-database grants to match, which is what a customer's own scoped
// user usually is. Measured on 7.0 — listDatabases names every database, and each
// read of an ungranted one comes back code 13 / Unauthorized.
describe("listCollectionNames on an inaccessible database", () => {
  function refusing(error: unknown) {
    return stub<MongoConnection>({
      // Stubbed at each level rather than one lookalike object: `db` returns a
      // Db and `listCollections` a cursor, and saying so is what makes the fake
      // fail if either signature moves.
      db: () =>
        stub<Db>({
          listCollections: () =>
            stub<ListCollectionsCursor>({ toArray: () => Promise.reject(error) }),
        }),
    });
  }

  it("raises DatabaseInaccessibleError for code 13", async () => {
    const failure = new MongoServerError({
      message: "not authorized on other to execute command { listCollections: 1 }",
      code: 13,
      codeName: "Unauthorized",
    });
    const collector = new MongoIndexCollector(refusing(failure));
    await expect(collector.listCollectionNames("other")).rejects.toBeInstanceOf(
      DatabaseInaccessibleError,
    );
  });

  // Atlas and mongos both wrap this refusal with their own numbering, so the
  // wording is matched as well as the code.
  it("falls back to the server's wording when no code survives", async () => {
    const failure = new MongoServerError({ message: "not authorized on other" });
    const collector = new MongoIndexCollector(refusing(failure));
    await expect(collector.listCollectionNames("other")).rejects.toBeInstanceOf(
      DatabaseInaccessibleError,
    );
  });

  // Anything else still aborts the pass. A collector that turned every failure
  // into "no access" would report a cluster as collected when the driver had died.
  it("lets every other failure through unchanged", async () => {
    const collector = new MongoIndexCollector(refusing(new Error("connection lost")));
    await expect(collector.listCollectionNames("app")).rejects.toThrow("connection lost");
  });

  // Not authorized is about the database, not about a collection inside it, so
  // the name it carries is the one the callers skip on.
  it("names the database it could not read", async () => {
    const failure = new MongoServerError({ message: "not authorized on other", code: 13 });
    const collector = new MongoIndexCollector(refusing(failure));
    await expect(collector.listCollectionNames("other")).rejects.toMatchObject({
      database: "other",
    });
  });
});
