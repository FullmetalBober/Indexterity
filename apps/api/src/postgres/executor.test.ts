import { describe, expect, it } from "vitest";
import type { PostgresWriter } from "./connection";
import {
  derivedName,
  HideUnsupportedError,
  PostgresIndexExecutor,
  postgresIndexName,
  quoteIdent,
} from "./executor";

// The connection is never reached by any of these: every one is refused before a
// statement is built, which is the property being asserted.
// Never reached: every call below is refused before a statement is built,
// which is the property being asserted. So the four methods say so rather than
// answering — a silent stub would let a refusal that stopped refusing pass.
const unreachable: PostgresWriter = {
  query: () => Promise.reject(new Error("no statement should have been built")),
  execute: () => Promise.reject(new Error("no statement should have been built")),
  serverIdentity: () => Promise.reject(new Error("no statement should have been built")),
  serverVersion: () => Promise.reject(new Error("no statement should have been built")),
};

describe("quoteIdent", () => {
  // Not about trust — every name here comes from the catalog. An index called
  // `order` is legal and unquoted it is a syntax error.
  it("quotes a reserved word and a name with a space", () => {
    expect(quoteIdent("order")).toBe('"order"');
    expect(quoteIdent("My Index")).toBe('"My Index"');
  });

  // The only escape a SQL identifier has.
  it("doubles an embedded quote", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe("derivedName", () => {
  // Postgres's own style, table_col_idx, with a descending key said so — which
  // postgres's default does not, and a re-order's replacement needs (#617).
  it("names an index in postgres's style, keeping a descending key", () => {
    expect(derivedName("orders", { customer_id: 1, created_at: -1 })).toBe(
      "orders_customer_id_created_at_desc_idx",
    );
  });

  // The server silently truncates past 63 bytes, after which the name we
  // recorded and the name on the cluster differ — and undo cannot find it.
  it("truncates to the identifier limit rather than letting the server do it", () => {
    const name = derivedName("t".repeat(60), { ["c".repeat(60)]: 1 });
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  });

  it("does not emit a character that would need quoting", () => {
    expect(derivedName("my table", { "a-b": 1 })).toBe("my_table_a_b_idx");
  });
});

describe("PostgresIndexExecutor", () => {
  // The structural backstop for #303. The pipeline checks
  // capabilities.hideIndexes long before here, so this firing is a caller bug —
  // which is why it is a named error rather than a failed database call.
  it("refuses to hide or un-hide, by name", () => {
    const executor = new PostgresIndexExecutor(unreachable, false);
    expect(() => executor.hide()).toThrow(HideUnsupportedError);
    expect(() => executor.unhide()).toThrow(HideUnsupportedError);
    expect(() => executor.hide()).toThrow(/no reversible index hide/);
    // Names the real reason, so a log reader is not left guessing.
    expect(() => executor.unhide()).toThrow(/superuser/);
  });

  // Read-only is enforced structurally, before anything is built or dialled.
  it("refuses every write on a read-only cluster", async () => {
    const executor = new PostgresIndexExecutor(unreachable, true);
    await expect(executor.drop("db", "s.t", "idx")).rejects.toThrow(/read-only/);
    await expect(executor.create("db", "s.t", { a: 1 }, {})).rejects.toThrow(/read-only/);
  });
});

// #617. An index is a relation, and relation names are unique per SCHEMA: named
// by its keys alone, the second table wanting the same index could never get it.
describe("postgresIndexName", () => {
  const customer = [{ field: "customer_id", direction: 1 as const }];

  it("puts the table in the name, so two tables wanting the same keys do not collide", () => {
    expect(postgresIndexName("orders", customer)).toBe("orders_customer_id_idx");
    expect(postgresIndexName("invoices", customer)).toBe("invoices_customer_id_idx");
  });

  it("tells a re-ordered replacement and a partial index apart from the original", () => {
    const ascending = postgresIndexName("orders", [
      { field: "a", direction: 1 },
      { field: "b", direction: 1 },
    ]);
    const reordered = postgresIndexName("orders", [
      { field: "a", direction: 1 },
      { field: "b", direction: -1 },
    ]);
    expect(reordered).toBe("orders_a_b_desc_idx");
    expect(reordered).not.toBe(ascending);
    expect(postgresIndexName("orders", customer, { partial: true })).toBe(
      "orders_customer_id_partial_idx",
    );
  });

  // Cut to the limit with a hash of the whole: two long names sharing their
  // first 63 bytes stay two names, and the same keys give the same name every
  // pass, which the recommendation's identity depends on.
  it("stays within 63 bytes without merging two long names into one", () => {
    const table = "t".repeat(40);
    const one = postgresIndexName(table, [{ field: `${"c".repeat(30)}_one`, direction: 1 }]);
    const two = postgresIndexName(table, [{ field: `${"c".repeat(30)}_two`, direction: 1 }]);
    expect(Buffer.byteLength(one)).toBe(63);
    expect(Buffer.byteLength(two)).toBe(63);
    expect(one).not.toBe(two);
    expect(postgresIndexName(table, [{ field: `${"c".repeat(30)}_one`, direction: 1 }])).toBe(one);
  });
});
