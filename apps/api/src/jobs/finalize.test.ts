import { describe, expect, it, vi } from "vitest";
import type { CollectionLatency } from "../engine/ports";
import { liveWritesOf } from "./finalize";

const latency = (writeOps: number): CollectionLatency => ({
  reads: { ops: 1, latencyMicros: 10 },
  writes: { ops: writeOps, latencyMicros: writeOps * 100 },
});

// #629. The write watch read every watched build's live totals on every pass and
// used them only when one graduated into the cumulative check — on SQL Server a
// whole-store scan of Query Store's plan XML per build, thirty-one of them an
// hour on production.
describe("liveWritesOf", () => {
  it("reads nothing until the cumulative check asks", () => {
    const collectionLatency = vi.fn(async () => latency(1));
    const latencyByCollection = vi.fn(async () => new Map([["dbo.orders", latency(1)]]));
    liveWritesOf({ collectionLatency, latencyByCollection });
    expect(collectionLatency).not.toHaveBeenCalled();
    expect(latencyByCollection).not.toHaveBeenCalled();
  });

  it("reads a database once, through the engine's batched read", async () => {
    const collectionLatency = vi.fn(async () => latency(1));
    const latencyByCollection = vi.fn(
      async () =>
        new Map([
          ["dbo.orders", latency(5)],
          ["dbo.items", latency(7)],
        ]),
    );
    const read = liveWritesOf({ collectionLatency, latencyByCollection });
    expect(await read("shop", "dbo.orders")).toEqual({ ops: 5, latencyMicros: 500 });
    expect(await read("shop", "dbo.items")).toEqual({ ops: 7, latencyMicros: 700 });
    expect(latencyByCollection).toHaveBeenCalledTimes(1);
    expect(collectionLatency).not.toHaveBeenCalled();
    await read("crm", "dbo.leads");
    expect(latencyByCollection).toHaveBeenCalledTimes(2);
  });

  // The port's contract: a collection the batched read does not name has no
  // recorded activity.
  it("reads a collection the batched read does not name as idle", async () => {
    const read = liveWritesOf({
      collectionLatency: async () => latency(9),
      latencyByCollection: async () => new Map(),
    });
    expect(await read("shop", "dbo.orders")).toEqual({ ops: 0, latencyMicros: 0 });
  });

  // MongoDB and PostgreSQL, whose per-collection reads are cheap.
  it("reads per collection where the engine has no batched read", async () => {
    const collectionLatency = vi.fn(async () => latency(3));
    const read = liveWritesOf({ collectionLatency });
    expect(await read("app", "orders")).toEqual({ ops: 3, latencyMicros: 300 });
    expect(collectionLatency).toHaveBeenCalledWith("app", "orders");
  });
});
