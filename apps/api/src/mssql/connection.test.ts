import { describe, expect, it } from "vitest";
import { PoolExhaustedError } from "../engine/ports";
import {
  asPoolExhausted,
  DATABASE_LISTING_SQL,
  listDatabaseNames,
  type MssqlReader,
} from "./connection";

// Unlike the other two adapters, SQL Server's whole rule is IN the statement —
// the server filters and hands back the answer — so what a unit test can hold is
// the statement itself, which is the only place the four names live. It is a
// constant, so it is read directly rather than captured from a fake.
function reader(names: string[]): MssqlReader<{ name: string }> {
  return { query: async () => names.map((name) => ({ name })) };
}

describe("listDatabaseNames", () => {
  // Excluded by name, which is the rule all three adapters follow (#347). `model`
  // and `msdb` go even though a real installation can be found with tables in
  // them — they are SQL Server's own working state, and application tables in one
  // are an anti-pattern rather than a shape to support. PostgreSQL's `postgres` is
  // the opposite case and is treated as one: not a system database at all.
  it("excludes the four the engine owns, and nothing else", () => {
    expect(DATABASE_LISTING_SQL).toMatch(/name NOT IN \('master', 'tempdb', 'model', 'msdb'\)/);
  });

  // On top of the names: an OFFLINE or RESTORING database cannot be listed into,
  // so it is not a database this product can observe.
  it("asks for online databases only", () => {
    expect(DATABASE_LISTING_SQL).toMatch(/state = 0/);
  });

  // A one-application instance reports one name, which is what keeps the observe
  // checkboxes off the screen — MIN_DATABASES_TO_CHOOSE is 2, and this is the
  // count the other two adapters had to be made to agree with.
  it("reports what the server answered", async () => {
    expect(await listDatabaseNames(reader(["app"]))).toEqual(["app"]);
  });
});

// tarn's TimeoutError sets no `name`, so only its constructor and its wording
// identify it. The "unknown reason" wording is the pool-full case and becomes
// PoolExhaustedError; a timeout that carries a connect failure keeps the driver's
// words, which the unreachable classifier reads (#454).
describe("asPoolExhausted", () => {
  class TimeoutError extends Error {}

  it("names the pool-full timeout", () => {
    const named = asPoolExhausted(new TimeoutError("operation timed out for an unknown reason"));
    expect(named).toBeInstanceOf(PoolExhaustedError);
    expect(named?.message).toContain("every connection to this cluster stayed busy");
  });

  it("leaves a timeout that names a connect failure alone", () => {
    expect(asPoolExhausted(new TimeoutError("Failed to connect to db:1433 in 5000ms"))).toBeNull();
  });

  it("leaves every other error alone", () => {
    expect(asPoolExhausted(new Error("operation timed out for an unknown reason"))).toBeNull();
    expect(asPoolExhausted("operation timed out for an unknown reason")).toBeNull();
  });
});
