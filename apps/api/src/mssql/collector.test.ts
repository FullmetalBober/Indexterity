import { describe, expect, it } from "vitest";
import {
  indexNamesFromForcedPlan,
  indexNamesFromHintText,
  MssqlIndexCollector,
  toMssqlIndexSpec,
} from "./collector";
import type { MssqlConnection } from "./connection";
import type { MssqlMemberConnections } from "./members";

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

// #202: the usage fan-out and the roster, against stubbed replicas. What each
// member REPORTS is proven live (integration/mssql.int.test.ts); what is
// proven here is that every member is asked, tagged with its own name and its
// own counter start, and that one member falling over loses only itself.
function stubMember(name: string, options: { ops?: number; fails?: boolean; role?: string } = {}) {
  return {
    serverIdentity: () =>
      Promise.resolve({
        serverName: name,
        startedAt: `2026-08-15T0${options.ops ?? 0}:00:00.000Z`,
        engineEdition: 3,
        version: null,
      }),
    query: () =>
      options.fails === true
        ? Promise.reject(new Error("connection lost"))
        : Promise.resolve([{ indexName: "ix_customer", ops: options.ops ?? 0 }]),
    localReplicaRole: () => Promise.resolve(options.role ?? null),
  } as unknown as MssqlConnection;
}

function stubMembers(dials: { host: string; state: string; connection: MssqlConnection | null }[]) {
  return {
    dials: () => Promise.resolve(dials),
    all: () => Promise.resolve(dials.flatMap((dial) => (dial.connection ? [dial.connection] : []))),
  } as unknown as MssqlMemberConnections;
}

describe("MssqlIndexCollector across availability replicas", () => {
  it("reports one reading per replica, each with its own name and counter start", async () => {
    const secondary = stubMember("ag2", { ops: 7, role: "secondary" });
    const collector = new MssqlIndexCollector(
      stubMember("ag1", { ops: 0, role: "primary" }),
      stubMembers([{ host: "ag2", state: "answered", connection: secondary }]),
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
      stubMember("ag1", { ops: 2, role: "primary" }),
      stubMembers([
        { host: "ag2", state: "answered", connection: stubMember("ag2", { fails: true }) },
      ]),
    );
    const usage = await collector.collectUsage("shop", "dbo.orders");
    expect(usage.map((stat) => stat.host)).toEqual(["ag1"]);
  });

  it("names every replica in the roster, dialled or not", async () => {
    const collector = new MssqlIndexCollector(
      stubMember("ag1", { role: "primary" }),
      stubMembers([
        {
          host: "ag2",
          state: "answered",
          connection: stubMember("ag2", { role: "secondary" }),
        },
        { host: "ag3", state: "unreachable", connection: null },
        { host: "ag4", state: "refused", connection: null },
      ]),
    );
    expect(await collector.collectNodes()).toEqual([
      { host: "ag1", role: "primary", state: "answered" },
      { host: "ag2", role: "secondary", state: "answered" },
      { host: "ag3", role: "unknown", state: "unreachable" },
      { host: "ag4", role: "unknown", state: "refused" },
    ]);
  });

  it("a standalone is still a roster of one standalone", async () => {
    const collector = new MssqlIndexCollector(stubMember("solo"));
    expect(await collector.collectNodes()).toEqual([
      { host: "solo", role: "standalone", state: "answered" },
    ]);
  });
});
