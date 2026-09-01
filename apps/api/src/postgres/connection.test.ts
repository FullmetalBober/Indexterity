import { describe, expect, it } from "vitest";
import { ClusterUnreachableError } from "../errors/unreachable";
import { DATABASE_LISTING_SQL, PostgresConnection, USER_TABLES_SQL } from "./connection";

// What a fresh install answers with once the statement's own WHERE has run:
// `template0` (connections disabled) and `template1` (a template) are excluded by
// the server, so the only row left is the database initdb made.
const FRESH: { datname: string }[] = [{ datname: "postgres" }];

// The real class with only its query boundary replaced, so the rule under test is
// the one the adapter runs — `listDatabaseNames` decides on top of `query`, and
// what it decides is the whole point of #347.
class Fake extends PostgresConnection {
  readonly probed: string[] = [];

  constructor(
    private readonly catalog: { datname: string }[],
    private readonly tablesIn: ReadonlySet<string>,
    // The database the string names, which decides whether the probe needs a
    // pool of its own.
    named = "postgres",
  ) {
    super(`postgresql://u:p@h:5432/${named}?sslmode=disable`);
  }

  // The two row reads rather than the generic `query<T>` underneath them, which
  // is what lets this answer with data instead of asserting one into shape. The
  // statements are constants, so they are read directly below.
  override async catalogRows(): Promise<{ datname: string }[]> {
    return this.catalog;
  }

  override async tableRows(database: string): Promise<{ present: boolean }[]> {
    this.probed.push(database);
    return [{ present: this.tablesIn.has(database === "" ? "postgres" : database) }];
  }
}

describe("listDatabaseNames", () => {
  // The bug: a one-application cluster reported two databases, so the observe
  // checkboxes appeared — the gate is MIN_DATABASES_TO_CHOOSE (2) — and one of the
  // boxes was a database nobody wants observed. The same shape on SQL Server
  // reports one name and offers no choice.
  it("drops an empty postgres so one application reads as one database", async () => {
    const conn = new Fake([...FRESH, { datname: "app" }], new Set());
    expect(await conn.listDatabaseNames()).toEqual(["app"]);
  });

  // And the install that really does keep tables there keeps it. Excluding by
  // name outright would hide it permanently: there is no "show system databases"
  // toggle to get it back with.
  it("keeps a postgres that holds a user table", async () => {
    const conn = new Fake([...FRESH, { datname: "app" }], new Set(["postgres"]));
    expect(await conn.listDatabaseNames()).toEqual(["postgres", "app"]);
  });

  // A cluster whose only database is `postgres`, with something in it, still has
  // one to observe. Reporting none would leave the settings page with nothing to
  // name and the collect with nothing to walk.
  it("keeps a postgres that is the only database there is", async () => {
    const conn = new Fake(FRESH, new Set(["postgres"]));
    expect(await conn.listDatabaseNames()).toEqual(["postgres"]);
  });

  it("probes the postgres database, and only when it is listed", async () => {
    const conn = new Fake([...FRESH, { datname: "app" }], new Set(), "app");
    await conn.listDatabaseNames();
    expect(conn.probed).toEqual(["postgres"]);

    const without = new Fake([{ datname: "app" }], new Set(), "app");
    expect(await without.listDatabaseNames()).toEqual(["app"]);
    expect(without.probed).toEqual([]);
  });

  // Through the pool that is already open when the string names `postgres`
  // itself — which is the most common shape a pasted string has. The pools are
  // keyed by the name they were asked for, so asking for it by name would hold a
  // second pool to the same database for the session's life.
  it("reuses the connection's own pool when the string already names it", async () => {
    const conn = new Fake(FRESH, new Set(["postgres"]), "postgres");
    expect(await conn.listDatabaseNames()).toEqual(["postgres"]);
    expect(conn.probed).toEqual([""]);
  });

  // Ordinary and partitioned tables only, the same relkind pair the collector
  // walks: a database holding nothing but views has no index to have an opinion
  // about. Asserted on the statement because the server is where this runs.
  it("asks about tables outside the system schemas", () => {
    expect(USER_TABLES_SQL).toMatch(/relkind IN \('r', 'p'\)/);
    expect(USER_TABLES_SQL).toMatch(/nspname <> ALL/);
  });

  // The server-side half of the rule, and the only place it lives: a template or
  // a database with connections disabled cannot be dialled, so it never reaches
  // the decision above.
  it("leaves templates and undiallable databases to the statement's own filter", () => {
    expect(DATABASE_LISTING_SQL).toMatch(/datallowconn AND NOT datistemplate/);
  });

  // Unreachable reads as empty: a database we cannot enter cannot be walked
  // either, so offering it would only produce a tick that collects nothing.
  it("drops a postgres it cannot read at all", async () => {
    class Refusing extends Fake {
      override async tableRows(): Promise<{ present: boolean }[]> {
        throw Object.assign(new Error("denied"), { code: "42501" });
      }
    }
    const conn = new Refusing([...FRESH, { datname: "app" }], new Set(["postgres"]));
    expect(await conn.listDatabaseNames()).toEqual(["app"]);
  });
});

// The customer boundary, on the one failure a unit test can produce for real
// (#420).
//
// A closed port on the loopback address: no server, no container, and the answer
// is immediate — node-pg raises `Error: connect ECONNREFUSED 127.0.0.1:1`, name
// "Error", which is precisely the shape our OWN control-plane pool produces when
// it flaps. What makes it classifiable is where it was raised, so this asserts
// the wiring rather than the pattern: that a dial made through
// `PostgresConnection` comes back typed.
//
// `sslmode=verify-full` so the TLS gate passes and the dial is what fails; the
// refusal happens at the socket, long before any certificate.
describe("a failed dial", () => {
  it("arrives typed, so the worker classifies it without guessing", async () => {
    const conn = new PostgresConnection("postgresql://u:p@127.0.0.1:1/db?sslmode=verify-full");
    await expect(conn.connect()).rejects.toBeInstanceOf(ClusterUnreachableError);
    // And the driver's own words survive, addresses and all (D112).
    await expect(conn.connect()).rejects.toThrow(/ECONNREFUSED 127\.0\.0\.1:1/);
  });
});
