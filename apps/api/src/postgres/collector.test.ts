import { describe, expect, it } from "vitest";
import { DatabaseInaccessibleError, workloadKey } from "../engine/ports";
import { attributesTo, joinTableRef, PostgresIndexCollector, splitTableRef } from "./collector";
import type { PgStatementRow, PostgresReader, PostgresStatementSource } from "./connection";

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

// The workload store is read once per database per pass, and reaching it is what
// opens that database's pool — so this read is the FIRST to touch an inaccessible
// database on the create side, not the last (#345). It used to go straight at the
// connection while every other per-database read went through the classifier,
// which reported "no access" as "no statements" and let the pass carry on
// measuring a cluster it could not see.
//
// The codes are node-pg's, measured on 18.6: 42501 is a role without CONNECT,
// 3D000 a database that is gone, 42P01 the extension not installed.
describe("the workload store on an inaccessible database", () => {
  // The catalog reads are not on this path, and a reader whose query rejects is
  // a COMPLETE PostgresReader: `Promise<never>` is honestly a `Promise<T[]>` for
  // every T, which is the one thing a double can say about a generic method.
  const NO_CATALOG: PostgresReader = {
    query: () => Promise.reject(new Error("no catalog read is expected on this path")),
    serverIdentity: () => Promise.reject(new Error("not reached in this test")),
    serverVersion: () => Promise.reject(new Error("not reached in this test")),
  };

  // The workload read, which the port names — so this answers statements rather
  // than claiming its rows are whatever the caller asked for.
  function workload(
    answer: (database: string) => Promise<PgStatementRow[]>,
  ): PostgresStatementSource {
    return { query: (_text, _params, database = "") => answer(database) };
  }

  const collectorOver = (answer: (database: string) => Promise<PgStatementRow[]>) =>
    new PostgresIndexCollector(NO_CATALOG, workload(answer));
  const refusal = (code: string) => Object.assign(new Error(`refused ${code}`), { code });

  it("raises DatabaseInaccessibleError rather than reporting an empty workload", async () => {
    const collector = collectorOver(() => Promise.reject(refusal("42501")));
    await expect(collector.collectDeletePatterns("gone", "public.orders")).rejects.toBeInstanceOf(
      DatabaseInaccessibleError,
    );
  });

  it("names the database it could not reach", async () => {
    const collector = collectorOver(() => Promise.reject(refusal("3D000")));
    await expect(collector.collectDeletePatterns("gone", "public.orders")).rejects.toMatchObject({
      database: "gone",
    });
  });

  // The extension is optional (WORKLOAD tier in diagnose.ts) and its absence is
  // not an access problem, so it still reads as no statements.
  it("still reads a missing pg_stat_statements as no statements", async () => {
    const collector = collectorOver(() => Promise.reject(refusal("42P01")));
    await expect(collector.collectDeletePatterns("app", "public.orders")).resolves.toEqual([]);
  });

  // One database of many. The batched read has a partial answer to give, so it
  // gives it — the reachable database's shapes survive the unreachable one.
  it("keeps the other databases when one is unreachable", async () => {
    const collector = collectorOver((database) =>
      database === "locked"
        ? Promise.reject(refusal("42501"))
        : Promise.resolve([
            { query: "SELECT * FROM public.orders WHERE id = $1", calls: "12", rows: "12" },
          ]),
    );
    const shapes = await collector.collectWorkload([
      { database: "locked", collection: "public.orders" },
      { database: "app", collection: "public.orders" },
    ]);
    expect([...shapes.keys()]).toEqual([workloadKey("app", "public.orders")]);
  });
});
