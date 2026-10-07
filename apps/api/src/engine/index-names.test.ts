import { describe, expect, it } from "vitest";
import { mongoAdapter } from "../mongo/adapter";
import { mssqlAdapter } from "../mssql/adapter";
import { postgresAdapter } from "../postgres/adapter";
import { keyedIndexName } from "./index-names";

const keys = [
  { field: "customer_id", direction: 1 as const },
  { field: "created_at", direction: -1 as const },
];

describe("keyedIndexName", () => {
  // The names every MongoDB and SQL Server recommendation already carries: a
  // change here renames live recommendations, which are matched by name.
  it("names an index by its keys and directions, the way MongoDB does", () => {
    expect(keyedIndexName(keys)).toBe("customer_id_1_created_at_-1");
    expect(keyedIndexName(keys, { partial: true })).toBe("customer_id_1_created_at_-1_partial");
  });
});

// #617: where a name has to be unique is each engine's to say.
describe("each engine's index names", () => {
  it("names by the keys where names are unique per collection or table", () => {
    expect(mongoAdapter.indexName("orders", keys)).toBe("customer_id_1_created_at_-1");
    expect(mssqlAdapter.indexName("dbo.orders", keys)).toBe("customer_id_1_created_at_-1");
    expect(mssqlAdapter.indexName("dbo.invoices", keys)).toBe("customer_id_1_created_at_-1");
  });

  it("puts the table in the name where names are unique per schema", () => {
    expect(postgresAdapter.indexName("public.orders", keys)).toBe(
      "orders_customer_id_created_at_desc_idx",
    );
    expect(postgresAdapter.indexName("public.invoices", keys)).toBe(
      "invoices_customer_id_created_at_desc_idx",
    );
  });
});
