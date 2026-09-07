import { describe, expect, it } from "vitest";
import { DatabaseInaccessibleError } from "../engine/ports";
import { at } from "../errors/at";
import {
  attributionsToRead,
  hintsFromStore,
  indexNamesFromForcedPlan,
  indexNamesFromHintText,
  isReadPlan,
  latencyFromPlans,
  MssqlIndexCollector,
  type PlanAttribution,
  shipPlanXml,
  tablePlanMarker,
  tablesOfPlan,
  toMssqlIndexSpec,
} from "./collector";
import type { MssqlSource } from "./connection";
import type { MssqlMemberRead, MssqlRoster, MssqlUsageMember } from "./members";

function row(overrides: Partial<Parameters<typeof toMssqlIndexSpec>[0][number]> = {}) {
  return {
    indexName: "ix_orders_customer",
    indexType: 2,
    isUnique: false,
    isPrimaryKey: false,
    isUniqueConstraint: false,
    isDisabled: false,
    hasFilter: false,
    filterDefinition: null,
    keyOrdinal: 1,
    isDescending: false,
    columnName: "customer_id",
    isIncluded: false,
    indexColumnId: 1,
    ...overrides,
  };
}

describe("toMssqlIndexSpec", () => {
  it("maps key order and directions", () => {
    const spec = toMssqlIndexSpec([
      row({ keyOrdinal: 2, columnName: "created_at", isDescending: true }),
      row({ keyOrdinal: 1, columnName: "customer_id" }),
    ]);
    expect(spec?.keys).toEqual([
      { field: "customer_id", direction: 1 },
      { field: "created_at", direction: -1 },
    ]);
  });

  it("marks every uniqueness flavour unique — isNeverDrop keys on it", () => {
    expect(toMssqlIndexSpec([row({ isUnique: true })])?.unique).toBe(true);
    expect(toMssqlIndexSpec([row({ isPrimaryKey: true })])?.unique).toBe(true);
    expect(toMssqlIndexSpec([row({ isUniqueConstraint: true })])?.unique).toBe(true);
  });

  it("maps the clustered index to the port's never-drop flag", () => {
    expect(toMssqlIndexSpec([row({ indexType: 1 })])?.isShardKey).toBe(true);
    expect(toMssqlIndexSpec([row()])?.isShardKey).toBe(false);
  });

  it("reports a disabled index as hidden and carries the filter verbatim", () => {
    const spec = toMssqlIndexSpec([
      row({ isDisabled: true, hasFilter: true, filterDefinition: "([status]='open')" }),
    ]);
    expect(spec?.hidden).toBe(true);
    expect(spec?.partial).toBe(true);
    expect(spec?.partialFilter).toEqual({ definition: "([status]='open')" });
  });

  it("returns null for no rows", () => {
    expect(toMssqlIndexSpec([])).toBeNull();
  });

  // sys.index_columns reports an INCLUDEd column as key_ordinal 0 /
  // is_included_column 1, and orders both halves by index_column_id — verified
  // on 2022, where INCLUDE (total, email) reports total first even though email
  // has the lower column_id. So the includes keep the order they were declared
  // in, and never leak into the keys.
  it("splits included columns out of the keys, in declared order", () => {
    const spec = toMssqlIndexSpec([
      row({ keyOrdinal: 1, indexColumnId: 1, columnName: "customer_id" }),
      row({ keyOrdinal: 0, indexColumnId: 2, columnName: "total", isIncluded: true }),
      row({ keyOrdinal: 0, indexColumnId: 3, columnName: "email", isIncluded: true }),
    ]);
    expect(spec?.keys).toEqual([{ field: "customer_id", direction: 1 }]);
    expect(spec?.include).toEqual(["total", "email"]);
  });

  it("leaves include off an index that has none", () => {
    expect(toMssqlIndexSpec([row()])).not.toHaveProperty("include");
  });

  it("returns null when every row is an include — INCLUDE cannot exist without a key", () => {
    expect(toMssqlIndexSpec([row({ keyOrdinal: 0, isIncluded: true, columnName: "total" })])).toBe(
      null,
    );
  });
});

describe("indexNamesFromHintText", () => {
  it("reads WITH (INDEX(…)) in its spellings", () => {
    expect(
      indexNamesFromHintText("SELECT * FROM dbo.orders WITH (INDEX(ix_orders_customer)) WHERE 1=1"),
    ).toEqual(["ix_orders_customer"]);
    expect(indexNamesFromHintText("FROM t WITH (INDEX = [ix weird name])")).toEqual([
      "ix weird name",
    ]);
    expect(indexNamesFromHintText("WITH (NOLOCK, INDEX([ix_a]), FORCESEEK)")).toEqual(["ix_a"]);
  });

  it("drops positional hints — INDEX(1) names the clustered index, which is never hidden", () => {
    expect(indexNamesFromHintText("WITH (INDEX(1))")).toEqual([]);
  });

  it("finds nothing in plain queries", () => {
    expect(indexNamesFromHintText("SELECT customer_id FROM dbo.orders WHERE id = 3")).toEqual([]);
  });
});

describe("indexNamesFromForcedPlan", () => {
  it("reads Index attributes, unescaping ]]", () => {
    const xml =
      '<Object Database="[probe]" Schema="[dbo]" Table="[orders]" ' +
      'Index="[ix_orders_customer]" IndexKind="NonClustered"></Object>' +
      '<Object Index="[ix_odd]]name]"></Object>';
    expect(indexNamesFromForcedPlan(xml)).toEqual(["ix_orders_customer", "ix_odd]name"]);
  });
});

// A database the login has no user in (#244). Msg 916 is what the server answers,
// verified on 2022 against a login provisioned for one database of two — and the
// number arrives on the driver's nested `originalError` as often as on the error
// itself, which is why both are walked.
describe("listCollectionNames on an inaccessible database", () => {
  // A complete MssqlSource. `serverIdentity` and `localReplicaRole` are never
  // reached on this path and say so by throwing, which is more honest than
  // asserting them away: if the path changes, the test names what it hit.
  function refusing(error: unknown): MssqlSource {
    return {
      query: () => Promise.reject(error),
      serverIdentity: () => Promise.reject(new Error("not reached in this test")),
      localReplicaRole: () => Promise.reject(new Error("not reached in this test")),
    };
  }

  it("raises DatabaseInaccessibleError for Msg 916 on the error itself", async () => {
    const failure = Object.assign(new Error("Some wrapper text"), { number: 916 });
    const collector = new MssqlIndexCollector(refusing(failure));
    await expect(collector.listCollectionNames("stagingdb")).rejects.toBeInstanceOf(
      DatabaseInaccessibleError,
    );
  });

  it("finds it on a nested originalError too", async () => {
    const failure = Object.assign(new Error("RequestError"), {
      originalError: Object.assign(new Error("inner"), { number: 916 }),
    });
    const collector = new MssqlIndexCollector(refusing(failure));
    await expect(collector.listCollectionNames("stagingdb")).rejects.toBeInstanceOf(
      DatabaseInaccessibleError,
    );
  });

  it("falls back to the server's own wording when no number survives", async () => {
    const failure = new Error(
      'The server principal "idx_ab12cd" is not able to access the database "stagingdb" under the current security context.',
    );
    const collector = new MssqlIndexCollector(refusing(failure));
    await expect(collector.listCollectionNames("stagingdb")).rejects.toBeInstanceOf(
      DatabaseInaccessibleError,
    );
  });

  // Anything else still aborts the pass. A collector that turned every failure
  // into "no access" would report a cluster as collected when the driver had died.
  it("lets every other failure through unchanged", async () => {
    const collector = new MssqlIndexCollector(refusing(new Error("connection lost")));
    await expect(collector.listCollectionNames("appdb")).rejects.toThrow("connection lost");
  });
});

// #202: the usage fan-out and the roster, against stubbed replicas. What each
// member REPORTS is proven live (integration/mssql.int.test.ts); what is
// proven here is that every member is asked, tagged with its own name and its
// own counter start, and that one member falling over loses only itself.
function stubMember(
  name: string,
  // `role` typed as the real method's union rather than `string`: a fake that
  // could answer "primary " or "PRIMARY" is a fake the collector would never
  // see, and the compiler now says so.
  options: { ops?: number; fails?: boolean; role?: "primary" | "secondary" } = {},
): MssqlUsageMember {
  return {
    serverIdentity: () =>
      Promise.resolve({
        serverName: name,
        startedAt: `2026-08-15T0${options.ops ?? 0}:00:00.000Z`,
        engineEdition: 3,
        version: null,
      }),
    // The port names the row, so this answers a usage reading rather than
    // claiming its data is whatever the caller asked for.
    query: () =>
      options.fails === true
        ? Promise.reject(new Error("connection lost"))
        : Promise.resolve([{ indexName: "ix_customer", ops: options.ops ?? 0 }]),
    localReplicaRole: () => Promise.resolve(options.role ?? null),
  };
}

// Complete: the collector reads `dials()` and nothing else, and `all()` is here
// because the interface has it — both implemented, none asserted away.
// Complete: both methods the collector can reach, neither asserted away.
function stubMembers(dials: readonly MssqlMemberRead[]): MssqlRoster {
  return {
    dials: () => Promise.resolve(dials),
    all: async () => dials.flatMap((dial) => (dial.connection ? [dial.connection] : [])),
  };
}

// The catalog reads are not on the replica path, and a source whose query
// rejects is a COMPLETE MssqlSource: `Promise<never>` is honestly a `Promise<T[]>`
// for every T, which is the one thing a double can say about a generic method.
// The local instance arrives as a member instead, which is all these two reads
// need of it.
const NO_CATALOG: MssqlSource = {
  query: () => Promise.reject(new Error("no catalog read is expected on this path")),
  serverIdentity: () => Promise.reject(new Error("the local member answers this")),
  localReplicaRole: () => Promise.reject(new Error("the local member answers this")),
};

describe("MssqlIndexCollector across availability replicas", () => {
  it("reports one reading per replica, each with its own name and counter start", async () => {
    const secondary = stubMember("ag2", { ops: 7, role: "secondary" });
    const collector = new MssqlIndexCollector(
      NO_CATALOG,
      stubMembers([{ host: "ag2", state: "answered", connection: secondary }]),
      stubMember("ag1", { ops: 0, role: "primary" }),
    );
    const usage = await collector.collectUsage("shop", "dbo.orders");
    expect(usage).toEqual([
      {
        indexName: "ix_customer",
        host: "ag1",
        ops: 0,
        since: new Date("2026-08-15T00:00:00.000Z").toISOString(),
      },
      {
        indexName: "ix_customer",
        host: "ag2",
        ops: 7,
        since: new Date("2026-08-15T07:00:00.000Z").toISOString(),
      },
    ]);
  });

  it("keeps the other members' readings when one dies mid-collect", async () => {
    const collector = new MssqlIndexCollector(
      NO_CATALOG,
      stubMembers([
        { host: "ag2", state: "answered", connection: stubMember("ag2", { fails: true }) },
      ]),
      stubMember("ag1", { ops: 2, role: "primary" }),
    );
    const usage = await collector.collectUsage("shop", "dbo.orders");
    expect(usage.map((stat) => stat.host)).toEqual(["ag1"]);
  });

  it("names every replica in the roster, dialled or not", async () => {
    const collector = new MssqlIndexCollector(
      NO_CATALOG,
      stubMembers([
        {
          host: "ag2",
          state: "answered",
          connection: stubMember("ag2", { role: "secondary" }),
        },
        { host: "ag3", state: "unreachable", connection: null },
        { host: "ag4", state: "refused", connection: null },
      ]),
      stubMember("ag1", { role: "primary" }),
    );
    expect(await collector.collectNodes()).toEqual([
      { host: "ag1", role: "primary", state: "answered" },
      { host: "ag2", role: "secondary", state: "answered" },
      { host: "ag3", role: "unknown", state: "unreachable" },
      { host: "ag4", role: "unknown", state: "refused" },
    ]);
  });

  it("a standalone is still a roster of one standalone", async () => {
    const collector = new MssqlIndexCollector(NO_CATALOG, undefined, stubMember("solo"));
    expect(await collector.collectNodes()).toEqual([
      { host: "solo", role: "standalone", state: "answered" },
    ]);
  });
});

// #454. The per-database read attributes each plan to its tables once, from the
// plan's own XML, and remembers it. These are its pure pieces; the live suite
// holds the composed read to the per-table one.
const PLAN = (statement: string, ...objects: string[]): string =>
  `<ShowPlanXML><StmtSimple StatementType="${statement}">` +
  objects.map((object) => `<RelOp><Object Database="[app]" ${object} /></RelOp>`).join("") +
  "</StmtSimple></ShowPlanXML>";

describe("tablesOfPlan", () => {
  it("names each table a plan touches once, in schema.table form", () => {
    const xml = PLAN(
      "SELECT",
      'Schema="[dbo]" Table="[orders]" Index="[ix_customer]"',
      'Schema="[sales]" Table="[dummy]"',
      'Schema="[dbo]" Table="[orders]" Index="[pk_orders]"',
    );
    expect(tablesOfPlan(xml)).toEqual(["dbo.orders", "sales.dummy"]);
  });

  it("reads a bracket in a name the way showplan writes it", () => {
    expect(tablesOfPlan(PLAN("SELECT", 'Schema="[dbo]" Table="[odd]]name]"'))).toEqual([
      "dbo.odd]name",
    ]);
    // And the marker the per-table LIKE is built from doubles it the same way.
    expect(tablePlanMarker("dbo.odd]name")).toBe('Schema="[dbo]" Table="[odd]]name]"');
  });

  it("reads nothing off a plan that names no table", () => {
    expect(tablesOfPlan(PLAN("SELECT"))).toEqual([]);
    expect(isReadPlan(PLAN("SELECT"))).toBe(true);
    expect(isReadPlan(PLAN("UPDATE", 'Schema="[dbo]" Table="[orders]"'))).toBe(false);
  });
});

describe("attributionsToRead", () => {
  const remembered = (hash: string): PlanAttribution => ({
    hash,
    tables: ["dbo.orders"],
    isSelect: true,
  });

  it("keeps a plan whose hash is the one remembered and reads the rest", () => {
    const known = new Map<number, PlanAttribution>([
      [1, remembered("0xA")],
      [2, remembered("0xB")],
      [3, remembered("0xC")],
    ]);
    const { kept, unread } = attributionsToRead(known, [
      { planId: 1, hash: "0xA" }, // unchanged
      { planId: 2, hash: "0xB2" }, // same id, different plan
      { planId: 4, hash: "0xD" }, // new
      // 3 is gone from the store
    ]);
    expect([...kept.keys()]).toEqual([1]);
    expect(unread).toEqual([2, 4]);
  });

  it("reads everything on a cold start", () => {
    const { kept, unread } = attributionsToRead(new Map(), [{ planId: 7, hash: "0x7" }]);
    expect(kept.size).toBe(0);
    expect(unread).toEqual([7]);
  });
});

// #470. The cache that makes a tunnelled collect affordable could only be
// written by an attribution read that ran to completion, and on the production
// cluster it never did: the budget abandoned the pass mid-loop, #454 cancelled
// the in-flight statement, the loop threw, and nothing was remembered. Every
// pass began again from an empty cache against the same store and died in the
// same place — measured as `queryStore:planXml 268s/1 (still running)` on
// collect after collect for a day.
//
// Driven through `shipPlanXml` rather than a fake Query Store: what broke is the
// loop's POLICY — how much is remembered, and when — and `fetch`/`remember` are
// a narrow port a test implements completely rather than a generic `query` it
// would have to assert into shape.
describe("shipping plan XML so an abandoned read leaves progress behind", () => {
  const XML = '<Object Schema="[dbo]" Table="[orders]" /> StatementType="SELECT"';

  // Answers every id asked for, until the nth chunk, which is cancelled — what a
  // statement killed by an abandoned pass looks like from here.
  function cancellingAfter(chunks: number) {
    const asked: number[][] = [];
    const fetch = (ids: readonly number[]) => {
      asked.push([...ids]);
      if (asked.length > chunks) return Promise.reject(new Error("Operation cancelled by user."));
      return Promise.resolve(ids.map((planId) => ({ planId, hash: `h${planId}`, xml: XML })));
    };
    return { fetch, asked };
  }

  const ids = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

  it("remembers the chunks that completed when a later one is cancelled", async () => {
    const store = cancellingAfter(2);
    const remembered: Map<number, PlanAttribution>[] = [];
    const kept = new Map<number, PlanAttribution>();

    await expect(
      shipPlanXml(ids(200), kept, store.fetch, (map) => remembered.push(new Map(map))),
    ).rejects.toThrow("Operation cancelled");

    // Two chunks landed, the third was cancelled — and the cancelled chunk still
    // handed back what the first two attributed, which is the fix.
    expect(store.asked).toHaveLength(3);
    expect(at(remembered, remembered.length - 1).size).toBe(at(store.asked).length * 2);
  });

  it("hands back the completed chunks even when the FIRST chunk is cancelled", async () => {
    // Nothing to remember, and `remember` is still called — so the caller's map
    // is written back pruned rather than left as whatever it was.
    const store = cancellingAfter(0);
    const remembered: Map<number, PlanAttribution>[] = [];

    await expect(
      shipPlanXml(ids(60), new Map(), store.fetch, (map) => remembered.push(new Map(map))),
    ).rejects.toThrow("Operation cancelled");

    expect(remembered).toHaveLength(1);
    expect(at(remembered).size).toBe(0);
  });

  it("leaves strictly less to read on every attempt, so a store converges", async () => {
    // The production shape: one chunk gets through per pass. What must hold is
    // that `attributionsToRead` then finds that chunk known and asks for less.
    const catalog = ids(150).map((planId) => ({ planId, hash: `h${planId}` }));
    let known = new Map<number, PlanAttribution>();
    const unreadCounts: number[] = [];

    for (let pass = 0; pass < 3; pass++) {
      const { kept, unread } = attributionsToRead(known, catalog);
      unreadCounts.push(unread.length);
      const store = cancellingAfter(1);
      await shipPlanXml(unread, kept, store.fetch, (map) => {
        known = new Map(map);
      }).catch(() => undefined);
    }

    // 150 plans, 50 a chunk, one chunk a pass: 150 unread, then 100, then 50.
    expect(unreadCounts).toEqual([150, 100, 50]);
  });

  it("asks for chunks small enough that one can finish on a slow link", async () => {
    // 500 was chosen when a read's cost was assumed to be its round trip. The
    // phase report measured the opposite — `queryStore:catalog` 5s across nine
    // databases against `queryStore:planXml` 268s for one — so the chunk is the
    // unit an abandonment destroys and it has to be small enough to land.
    const store = cancellingAfter(99);
    await shipPlanXml(ids(120), new Map(), store.fetch, () => undefined);

    expect(store.asked.map((chunk) => chunk.length)).toEqual([50, 50, 20]);
  });

  it("does nothing at all when the store has no unread plans", async () => {
    const store = cancellingAfter(0);
    let remembers = 0;

    await shipPlanXml([], new Map(), store.fetch, () => {
      remembers += 1;
    });

    expect(store.asked).toEqual([]);
    // No chunk, so no write — `planAttributions` writes the pruned map itself on
    // this path, which is the one case the loop cannot cover.
    expect(remembers).toBe(0);
  });
});

describe("latencyFromPlans", () => {
  const plans = new Map<number, PlanAttribution>([
    [1, { hash: "0x1", tables: ["dbo.orders"], isSelect: true }],
    [2, { hash: "0x2", tables: ["dbo.orders", "sales.dummy"], isSelect: true }],
    [3, { hash: "0x3", tables: ["dbo.orders"], isSelect: false }],
  ]);

  it("sums reads and writes per table, counting a join for every table it names", () => {
    const out = latencyFromPlans(plans, [
      { planId: 1, execs: 9, micros: 3133.4 },
      { planId: 2, execs: 3, micros: 2754 },
      { planId: 3, execs: 5, micros: 113088.6 },
      { planId: 99, execs: 1, micros: 1 }, // a plan the store no longer describes
    ]);
    expect(out.get("dbo.orders")).toEqual({
      reads: { ops: 12, latencyMicros: 5887 },
      writes: { ops: 5, latencyMicros: 113089 },
    });
    expect(out.get("sales.dummy")).toEqual({
      reads: { ops: 3, latencyMicros: 2754 },
      writes: { ops: 0, latencyMicros: 0 },
    });
    expect(out.has("dbo.nothing")).toBe(false);
  });
});

describe("hintsFromStore", () => {
  it("attributes hinted texts by table name, case-insensitively, and forced plans by marker", () => {
    const out = hintsFromStore(
      ["dbo.orders", "dbo.[odd name]", "sales.dummy"],
      [
        "SELECT COUNT(*) FROM dbo.Orders WITH (INDEX(ix_customer)) WHERE status = 'closed'",
        "CREATE INDEX ix_orders_status ON dbo.orders (status)",
      ],
      [PLAN("SELECT", 'Schema="[sales]" Table="[dummy]" Index="[ix_dummy_customer]"')],
    );
    expect(out.get("dbo.orders")).toEqual(["ix_customer"]);
    expect(out.get("sales.dummy")).toEqual(["ix_dummy_customer"]);
    expect(out.get("dbo.[odd name]")).toEqual([]);
  });
});
