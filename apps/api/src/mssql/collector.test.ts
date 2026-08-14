import { describe, expect, it } from "vitest";
import { indexNamesFromForcedPlan, indexNamesFromHintText, toMssqlIndexSpec } from "./collector";

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
