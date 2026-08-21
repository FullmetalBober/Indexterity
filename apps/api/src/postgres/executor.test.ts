import { describe, expect, it } from "vitest";
import { derivedName, HideUnsupportedError, PostgresIndexExecutor, quoteIdent } from "./executor";

// The connection is never reached by any of these: every one is refused before a
// statement is built, which is the property being asserted.
const unreachable = null as unknown as ConstructorParameters<typeof PostgresIndexExecutor>[0];

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
  it("names an index the way postgres would", () => {
    expect(derivedName("orders", { customer_id: 1, created_at: -1 })).toBe(
      "orders_customer_id_created_at_idx",
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
