import { describe, expect, it } from "vitest";
import type { QueryShape } from "../engine/types";
import {
  isScanning,
  type PendingShape,
  ShapeLedger,
  severityOf,
  storedShapeOf,
  storedShapeSchema,
} from "./workload-shapes";

function shape(over: Partial<QueryShape> = {}): QueryShape {
  return {
    equality: ["status"],
    sort: [],
    range: [],
    collscan: true,
    count: 100,
    ...over,
  };
}

describe("storedShapeOf", () => {
  // The storage decision this feature turned on (D128). `constants` is the one
  // field carrying real customer VALUES — only the profiler populates it — and
  // the page has no use for a literal, so it is dropped on the way in rather
  // than written into our control-plane postgres.
  it("keeps the shape and drops the literals", () => {
    const stored = storedShapeOf(
      shape({ constants: { tenant: "acme-corp", plan: "enterprise" }, equality: ["tenant"] }),
    );

    expect(stored.equality).toEqual(["tenant"]);
    expect(JSON.stringify(stored)).not.toContain("acme-corp");
    expect(Object.keys(stored).sort()).toEqual([
      "collscan",
      "equality",
      "range",
      "sort",
      "sortedInMemory",
    ]);
  });

  // The generated digest hashes `shape::text`, so two readings of one shape must
  // produce byte-identical jsonb — which they only do if the FIELD SET is fixed
  // rather than spread from whatever optional keys a reading happened to carry.
  it("writes the same fields whether or not the source reported a sort", () => {
    const a = storedShapeOf(shape());
    const b = storedShapeOf(shape({ sortedInMemory: true }));

    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(a.sortedInMemory).toBe(false);
    expect(b.sortedInMemory).toBe(true);
  });

  it("round-trips through the schema the read side parses with", () => {
    const stored = storedShapeOf(
      shape({ sort: [{ field: "created", direction: -1 }], range: ["total"] }),
    );

    expect(storedShapeSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });
});

describe("isScanning", () => {
  // A shape the planner served from an index is not a finding, and storing it
  // would make the table the size of the workload rather than of the problem.
  it("is true for a scan and for an in-memory sort, false for a served query", () => {
    expect(isScanning(shape({ collscan: true }))).toBe(true);
    expect(isScanning(shape({ collscan: false, sortedInMemory: true }))).toBe(true);
    expect(isScanning(shape({ collscan: false }))).toBe(false);
  });
});

describe("severityOf", () => {
  it("reads back the two tiers the engine escalates on", () => {
    expect(severityOf("CRITICAL")).toBe("CRITICAL");
    expect(severityOf("ELEVATED")).toBe("ELEVATED");
  });

  // The column is text so a new grade costs no migration, which means the value
  // can be one this build has never heard of. Falling back to the mildest is the
  // safe direction: overstating severity from a value we cannot read would send
  // somebody looking for a problem on our word.
  it("falls back to the mildest tier for a grade it does not know", () => {
    expect(severityOf("APOCALYPTIC")).toBe("ROUTINE");
    expect(severityOf("")).toBe("ROUTINE");
  });
});

describe("ShapeLedger", () => {
  const NS = { database: "shop", collection: "orders" } as const;

  // One row, found by the field that distinguishes the fixtures here. The ledger
  // hands back its rows rather than one accessor per field, so a test reads the
  // row the same way `flush` does.
  function only(ledger: ShapeLedger): PendingShape {
    const [row] = ledger.entries();
    if (row === undefined) throw new Error("the ledger recorded nothing");
    return row;
  }

  it("records one row per distinct shape, however often it is noted", () => {
    const ledger = new ShapeLedger();
    ledger.note(NS.database, NS.collection, shape(), 1000, "no-candidate");
    ledger.note(NS.database, NS.collection, shape(), 1000, "below-cost-floor");
    ledger.note(NS.database, NS.collection, shape({ equality: ["other"] }), 1000, "no-candidate");

    expect(ledger.size).toBe(2);
  });

  // Later means further down the pipeline: the collection is entered by seeding
  // every scanning shape, and each producer then overwrites with the gate that
  // actually fired.
  it("lets a later gate replace the seeded residual", () => {
    const ledger = new ShapeLedger();
    const one = shape();
    ledger.note(NS.database, NS.collection, one, 1000, "no-candidate");
    ledger.note(NS.database, NS.collection, one, 1000, "cooldown");

    expect(only(ledger).outcome).toBe("cooldown");
  });

  // The one exception, and the reason it exists: three producers read the same
  // shapes and disagree by design — a re-order answers an in-memory sort that
  // the create rule declines as already indexed — so a shape one of them acted
  // on must not read as declined because another had nothing to say about it.
  it("keeps a proposal against a later decline", () => {
    const ledger = new ShapeLedger();
    const one = shape({ collscan: false, sortedInMemory: true });
    ledger.resolve(NS.database, NS.collection, 1000, [one], "proposed", "status_1_created_-1");
    ledger.note(NS.database, NS.collection, one, 1000, "index-exists");

    expect(only(ledger).outcome).toBe("proposed");
    expect(only(ledger).proposedIndex).toBe("status_1_created_-1");
  });

  // `resolve` takes whatever a candidate says it answers, and a candidate that
  // consolidated a served shape must not put a row on the page for it.
  it("ignores a non-scanning shape a candidate happens to carry", () => {
    const ledger = new ShapeLedger();
    ledger.resolve(NS.database, NS.collection, 1000, [shape({ collscan: false })], "proposed", "x");

    expect(ledger.size).toBe(0);
  });

  // Documents walked per week is the number the page ranks by, and the fallback
  // is the one `weeklyScanCost` documents: a collection scan walks the whole
  // collection by definition, so the collection size is the per-execution figure
  // when the source cannot report one.
  it("estimates weekly documents from the collection size when the source is silent", () => {
    const ledger = new ShapeLedger();
    // 168 hours of window means the count IS the weekly rate.
    const scan = shape({ count: 10, observedForHours: 168 });
    ledger.note(NS.database, NS.collection, scan, 5000, "below-cost-floor");

    expect(only(ledger).weeklyDocsExamined).toBe(50_000);
  });

  // An in-memory sort has no such identity — it reached its documents through an
  // index — so an unreported figure stays unknown. Zero would read as "this
  // costs nothing", which is the wrong thing to say about the failure that ends
  // in an error at 100 MB.
  it("leaves an unmeasured in-memory sort's weekly cost null rather than zero", () => {
    const ledger = new ShapeLedger();
    const sorting = shape({ collscan: false, sortedInMemory: true, observedForHours: 168 });
    ledger.note(NS.database, NS.collection, sorting, 5000, "no-candidate");

    expect(only(ledger).weeklyDocsExamined).toBeNull();
  });

  it("uses the reported figure when there is one", () => {
    const ledger = new ShapeLedger();
    const scan = shape({ count: 10, docsExamined: 1000, observedForHours: 168 });
    ledger.note(NS.database, NS.collection, scan, 5_000_000, "no-candidate");

    // 100 per execution, 10 executions a week — the collection's size does not
    // enter into it once the source has answered.
    expect(only(ledger).weeklyDocsExamined).toBe(1000);
  });

  // `{ application: null }` and `{}` are the same fact, and only one of them
  // keeps the digest stable across a driver version that stopped reporting a
  // field — a shape whose identity moved would get a fresh `first_seen_at` and
  // read as new.
  it("strips absent client fields rather than storing them as nulls", () => {
    const ledger = new ShapeLedger();
    const one = shape({ clients: [{ driver: "nodejs" }] });
    ledger.note(NS.database, NS.collection, one, 1000, "no-candidate");

    expect(only(ledger).clients).toEqual([{ driver: "nodejs" }]);
  });
});
