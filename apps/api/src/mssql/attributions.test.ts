import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributionBytesHeld,
  attributionsHeld,
  connectionFingerprint,
  entryBytes,
  forgetAttributions,
  ownAttributions,
  setAttributionCeilingForTests,
  sharedAttributions,
} from "./attributions";
import type { PlanAttribution } from "./collector";

// The point of this module is that a store outlives the connection that filled
// it (#478). Everything below is about lifetime, isolation and what it may hold;
// what a plan says is collector.ts's business.
afterEach(() => {
  forgetAttributions();
  setAttributionCeilingForTests(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
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
  // Every plan below is an attribution with no facts, so each costs the same and
  // a ceiling of N of them reads as one.
  const EACH = entryBytes({ hash: "h", tables: ["dbo.orders"], isSelect: true });
  const ceilingOf = (plans: number): void => setAttributionCeilingForTests(plans * EACH);

  beforeEach(() => {
    // Quiet, and asserted on where it matters.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("gives up plans from the least recently written database, not the one just written", () => {
    ceilingOf(50_000);
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("Oldest", plans(30_000));
    store.set("Newest", plans(30_000, 100_000));

    expect(attributionsHeld()).toBeLessThanOrEqual(50_000);
    expect(store.get("Newest")?.size).toBe(30_000);
    // Ten thousand over, so ten thousand go — and from the front: the plans
    // written longest ago.
    expect(store.get("Oldest")?.size).toBe(20_000);
    expect(store.get("Oldest")?.has(0)).toBe(false);
    expect(store.get("Oldest")?.has(29_999)).toBe(true);
  });

  // #588. The defect: a whole database went for any overflow, so a store a few
  // hundred plans over the line re-shipped five thousand on the next pass, went
  // over again and dropped the next database — on every pass.
  it("gives up as little as it takes", () => {
    ceilingOf(10_000);
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("LoyaltyDB", plans(5_000));
    store.set("CMSdb", plans(5_100, 100_000));

    expect(attributionsHeld()).toBe(10_000);
    expect(store.get("LoyaltyDB")?.size).toBe(4_900);
    expect(attributionBytesHeld()).toBeLessThanOrEqual(10_000 * EACH);
  });

  it("keeps a database that is rewritten every pass ahead of an idle one", () => {
    ceilingOf(50_000);
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("Busy", plans(20_000));
    store.set("Idle", plans(20_000, 100_000));
    // Rewritten, as a collect does every hour: this has to move it to the back
    // of the eviction order or the hot database is the one that gives way.
    store.set("Busy", plans(20_000));
    store.set("Arriving", plans(20_000, 200_000));

    expect(store.get("Busy")?.size).toBe(20_000);
    expect(store.get("Arriving")?.size).toBe(20_000);
    expect(store.get("Idle")?.size).toBe(10_000);
  });

  it("holds a single database larger than the ceiling rather than looping", () => {
    // Dropping the key just written would evict the answer being used and leave
    // the loop nothing to free — so the ceiling yields to it instead.
    ceilingOf(50_000);
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("Enormous", plans(60_000));

    expect(store.get("Enormous")?.size).toBe(60_000);
  });

  // `get` hands out the stored map, and a pass reads it after an await — so the
  // map a reader holds must never shrink under it.
  it("trims a copy, so a map already handed out keeps its whole view", () => {
    ceilingOf(10_000);
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("LoyaltyDB", plans(6_000));
    const reading = store.get("LoyaltyDB");
    store.set("CMSdb", plans(6_000, 100_000));

    expect(reading?.size).toBe(6_000);
    expect(store.get("LoyaltyDB")?.size).toBe(4_000);
  });

  // A plan that suggest has read carries its facts, and costs more for it.
  it("counts what an entry carries, not only that it exists", () => {
    const bare: PlanAttribution = { hash: "h", tables: ["dbo.orders"], isSelect: true };
    const read: PlanAttribution = {
      ...bare,
      workload: {
        shapes: [
          {
            table: "dbo.orders",
            equality: ["customer_id"],
            range: [],
            sort: [{ field: "status", direction: -1 }],
            collscan: false,
            sortedInMemory: true,
            constants: { status: "open" },
          },
        ],
        missing: [],
        purges: [],
      },
    };
    expect(entryBytes(read)).toBeGreaterThan(entryBytes(bare));
  });

  // Said, because the failure this replaced was silent. Once a minute at most:
  // a store that does not fit drops plans on every chunk it ships.
  it("says when it gives plans up, at most once a minute", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    ceilingOf(1_000);
    const store = sharedAttributions(connectionFingerprint(CONN));
    store.set("A", plans(1_000));
    store.set("B", plans(500, 100_000));
    store.set("C", plans(500, 200_000));

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain("dropped 500 plan(s)");

    vi.setSystemTime(Date.now() + 61_000);
    store.set("D", plans(250, 300_000));
    expect(console.warn).toHaveBeenCalledTimes(2);
    // What went since the last line, not since the first.
    expect(vi.mocked(console.warn).mock.calls[1]?.[0]).toContain("dropped 750 plan(s)");
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
