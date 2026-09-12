import { afterEach, describe, expect, it } from "vitest";
import {
  connectionFingerprint,
  forgetSelfReads,
  ownSelfReads,
  READS_PER_COLL_STATS_LATENCY,
  READS_PER_COLL_STATS_STORAGE,
  readsPerIndexStats,
  selfReadsHeld,
  sharedSelfReads,
} from "./self-reads";

const V8 = { major: 8, minor: 0, text: "8.0.0" };

afterEach(forgetSelfReads);

describe("selfReads", () => {
  it("accumulates per namespace", () => {
    const tally = ownSelfReads();
    tally.add("app", "orders", readsPerIndexStats(V8));
    tally.add("app", "orders", READS_PER_COLL_STATS_STORAGE);
    tally.add("app", "customers", READS_PER_COLL_STATS_LATENCY);
    expect(tally.count("app", "orders")).toBe(3);
    expect(tally.count("app", "customers")).toBe(1);
  });

  it("is zero for a namespace nothing has read", () => {
    expect(ownSelfReads().count("app", "never-looked-at")).toBe(0);
  });

  // One collect pass on one namespace: $indexStats, $collStats storageStats and
  // $collStats latencyStats. Four, which is exactly half the floor measured on
  // the hosted dev cluster — the other half was the suggest pass.
  it("adds up to the floor a collect pass leaves", () => {
    const tally = ownSelfReads();
    tally.add("app", "orders", readsPerIndexStats(V8));
    tally.add("app", "orders", READS_PER_COLL_STATS_STORAGE);
    tally.add("app", "orders", READS_PER_COLL_STATS_LATENCY);
    expect(tally.count("app", "orders")).toBe(4);
  });

  // The reason it is injected rather than reached for: a collector built outside
  // a session must not be able to disturb a live cluster's count, and the tests
  // must not need a global reset between cases.
  it("keeps a caller's own tally out of the shared one", () => {
    const mine = ownSelfReads();
    mine.add("app", "orders", 5);
    expect(sharedSelfReads(connectionFingerprint("mongodb://host/db")).count("app", "orders")).toBe(
      0,
    );
  });

  it("keeps two connection targets apart", () => {
    const a = sharedSelfReads(connectionFingerprint("mongodb://a/db"));
    const b = sharedSelfReads(connectionFingerprint("mongodb://b/db"));
    a.add("app", "orders", 4);
    expect(a.count("app", "orders")).toBe(4);
    expect(b.count("app", "orders")).toBe(0);
  });

  // Rotated credentials reach a server whose counters mean something else, so the
  // tally starts over — which the analysis reads as one unknowable interval.
  it("starts a new tally when the connection string changes", () => {
    sharedSelfReads(connectionFingerprint("mongodb://host/db?u=old")).add("app", "orders", 9);
    expect(
      sharedSelfReads(connectionFingerprint("mongodb://host/db?u=new")).count("app", "orders"),
    ).toBe(0);
  });

  it("does not hold the connection string it was keyed by", () => {
    const secret = "mongodb://user:hunter2@host/db";
    expect(connectionFingerprint(secret)).not.toContain("hunter2");
    expect(connectionFingerprint(secret)).toBe(connectionFingerprint(secret));
  });

  it("survives being read for a namespace before anything wrote one", () => {
    const shared = sharedSelfReads(connectionFingerprint("mongodb://host/db"));
    expect(shared.count("app", "orders")).toBe(0);
    shared.add("app", "orders", 1);
    expect(shared.count("app", "orders")).toBe(1);
    expect(selfReadsHeld()).toBe(1);
  });
});

// `$indexStats` costs the collection it reads, and what it costs depends on the
// SERVER — measured on three, same probe, same collection: 2 on 6.0.28, 1 on
// 7.0.39 and 8.2.9. The original table was taken on 8.0 alone, so on a 6.0
// server this product under-counted its own reads by one per namespace per pass
// and the activity gate stayed defeated there after #493 shipped.
describe("readsPerIndexStats", () => {
  it("is two on 6.0 and one from 7.0", () => {
    expect(readsPerIndexStats({ major: 6, minor: 0, text: "6.0.28" })).toBe(2);
    expect(readsPerIndexStats({ major: 7, minor: 0, text: "7.0.39" })).toBe(1);
    expect(readsPerIndexStats({ major: 8, minor: 2, text: "8.2.9" })).toBe(1);
  });

  // Over-counting subtracts too much, which withholds active time and therefore
  // withholds drops. Under-counting manufactures activity and allows them. Only
  // one of those is survivable in a gate whose job is to refuse.
  it("takes the higher number for a server it cannot identify", () => {
    expect(readsPerIndexStats(null)).toBe(2);
  });
});
