import { describe, expect, it } from "vitest";
import { joinTableRef, splitTableRef } from "./collector";

// `collection` is a schema-qualified table here, because Postgres has a level
// MongoDB does not and folding it away would make two tables of the same name in
// different schemas one row.
describe("splitTableRef", () => {
  it("splits a qualified name", () => {
    expect(splitTableRef("sales.orders")).toEqual({ schema: "sales", table: "orders" });
  });

  // Unqualified means the search path's default, which is `public` on every
  // install that has not changed it.
  it("defaults an unqualified name to public", () => {
    expect(splitTableRef("orders")).toEqual({ schema: "public", table: "orders" });
  });

  // A table name may contain a dot. Splitting on the FIRST one and keeping the
  // remainder is what makes the round trip exact — splitting on the last would
  // move part of the table name into the schema.
  it("keeps a dot in the table name where it belongs", () => {
    expect(splitTableRef("sales.orders.v2")).toEqual({ schema: "sales", table: "orders.v2" });
    expect(joinTableRef(splitTableRef("sales.orders.v2"))).toBe("sales.orders.v2");
  });

  it("round-trips every shape it accepts", () => {
    for (const value of ["sales.orders", "public.t", "weird.name.with.dots"]) {
      expect(joinTableRef(splitTableRef(value))).toBe(value);
    }
  });
});
