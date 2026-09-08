import { afterEach, describe, expect, it } from "vitest";
import {
  attributionsHeld,
  connectionFingerprint,
  forgetAttributions,
  ownAttributions,
  sharedAttributions,
} from "./attributions";
import type { PlanAttribution } from "./collector";

// The point of this module is that a store outlives the connection that filled
// it (#478). Everything below is about lifetime and isolation; what a plan says
// is collector.ts's business.
afterEach(() => {
  forgetAttributions();
});

const plans = (count: number, from = 0): Map<number, PlanAttribution> =>
  new Map(
    Array.from({ length: count }, (_, i) => [
      from + i,
      { hash: `h${from + i}`, tables: ["dbo.orders"], isSelect: true },
    ]),
  );

const CONN = "mssql://sa:pw@sql.example.net:1433?trustservercertificate=true";

describe("a store that outlives its connection", () => {
  // The defect, stated as a test. A session is closed after five idle minutes
  // and the next pass builds a new collector; what a plan names has not changed,
  // so the second collector must find the first one's work.
  it("hands a second reader what the first one attributed", () => {
    const first = sharedAttributions(connectionFingerprint(CONN));
    first.set("LoyaltyDB", plans(3));

    // A different object, as a rebuilt session's collector would have.
    const second = sharedAttributions(connectionFingerprint(CONN));
    expect(second.get("LoyaltyDB")?.size).toBe(3);
  });

  it("keeps databases apart within one connection", () => {
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("LoyaltyDB", plans(3));
    store.set("ReportServer", plans(2, 100));

    expect(store.get("LoyaltyDB")?.size).toBe(3);
    expect(store.get("ReportServer")?.size).toBe(2);
    expect(store.get("CMSdb")).toBeUndefined();
  });

  // Rotated credentials are a different fingerprint, which is deliberate: the
  // pool dooms its entry on exactly that change, and the string might now reach
  // a different server whose plan ids mean something else.
  it("does not share between connection strings", () => {
    sharedAttributions(connectionFingerprint(CONN)).set("LoyaltyDB", plans(3));
    const rotated = sharedAttributions(connectionFingerprint(`${CONN}&applicationintent=readonly`));

    expect(rotated.get("LoyaltyDB")).toBeUndefined();
  });

  it("fingerprints without carrying the credential", () => {
    const fingerprint = connectionFingerprint(CONN);
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint).not.toContain("pw");
  });
});

describe("the ceiling", () => {
  it("drops the least recently written database, not the one just written", () => {
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("Oldest", plans(30_000));
    store.set("Newest", plans(30_000, 100_000));

    // Over the 50,000 ceiling, so something had to go — and it must not be the
    // answer the caller is in the middle of using.
    expect(attributionsHeld()).toBeLessThanOrEqual(50_000);
    expect(store.get("Newest")?.size).toBe(30_000);
    expect(store.get("Oldest")).toBeUndefined();
  });

  it("keeps a database that is rewritten every pass ahead of an idle one", () => {
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("Busy", plans(20_000));
    store.set("Idle", plans(20_000, 100_000));
    // Rewritten, as a collect does every hour: this has to move it to the back
    // of the eviction order or the hot database is the one that gets dropped.
    store.set("Busy", plans(20_000));
    store.set("Arriving", plans(20_000, 200_000));

    expect(store.get("Busy")?.size).toBe(20_000);
    expect(store.get("Arriving")?.size).toBe(20_000);
    expect(store.get("Idle")).toBeUndefined();
  });

  it("holds a single database larger than the ceiling rather than looping", () => {
    // Dropping the key just written would evict the answer being used and leave
    // the loop nothing to free — so the ceiling yields to it instead.
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("Enormous", plans(60_000));

    expect(store.get("Enormous")?.size).toBe(60_000);
  });
});

describe("a store of one caller's own", () => {
  // `diagnose` and the unit tests build a collector with no session behind it.
  // They must not read or write the shared store.
  it("is isolated from the shared one", () => {
    ownAttributions().set("LoyaltyDB", plans(3));
    expect(attributionsHeld()).toBe(0);
    expect(sharedAttributions(connectionFingerprint(CONN)).get("LoyaltyDB")).toBeUndefined();
  });

  it("still remembers within itself", () => {
    const mine = ownAttributions();
    mine.set("LoyaltyDB", plans(3));
    expect(mine.get("LoyaltyDB")?.size).toBe(3);
  });
});
