import { describe, expect, it } from "vitest";
import { attributesTo, joinTableRef, splitTableRef } from "./collector";

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

// The bug this pins: the first version used `\m`/`\M`, which are PostgreSQL's
// word-boundary escapes and mean nothing in JavaScript. As literals they made
// every match fail, and the symptom was an EMPTY workload rather than an error —
// exactly the kind of failure a unit test catches and an integration run reports
// as "this cluster has no query shapes".
describe("table attribution in normalized SQL", () => {
  const mentions = (query: string, collection: string) =>
    attributesTo(query, splitTableRef(collection));

  it("matches a schema-qualified name", () => {
    expect(mentions("SELECT * FROM sales.orders WHERE a = $1", "sales.orders")).toBe(true);
  });

  // By far the common case: a statement written against the search path.
  it("matches a bare name", () => {
    expect(mentions("SELECT * FROM orders WHERE a = $1", "sales.orders")).toBe(true);
  });

  // The whole reason a boundary is needed at all.
  it("does not claim a table whose name merely starts the same", () => {
    expect(mentions("SELECT * FROM sales.orders_archive", "sales.orders")).toBe(false);
    expect(mentions("SELECT * FROM orders_archive", "sales.orders")).toBe(false);
  });

  it("matches an aliased reference", () => {
    expect(mentions("SELECT * FROM sales.orders o WHERE o.status = $1", "sales.orders")).toBe(true);
  });

  it("does not match an unrelated table", () => {
    expect(mentions("SELECT * FROM sales.customers WHERE a = $1", "sales.orders")).toBe(false);
  });
});
