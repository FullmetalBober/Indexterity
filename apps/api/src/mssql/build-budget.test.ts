import mssql from "mssql";
import { describe, expect, it } from "vitest";
import { buildRequest } from "./connection";

// The one thing a cast cannot tell you.
//
// `new Request(pool, { requestTimeout })` is honoured by mssql 12.7 and absent
// from @types/mssql 12.3, so `buildRequest` casts. A cast is a claim the
// compiler cannot check, and the failure mode if the claim is wrong is silent:
// the request would quietly take the POOL's timeout — 900s, sized for a DMV
// read — and a long index build would fail exactly as it did before #410, with
// nothing to show it had been fixed and un-fixed.
//
// So this reads the override back off the constructed request. It reaches into
// a field the types do not describe, which is the point: that field is the
// contract being relied on.
describe("buildRequest", () => {
  it("puts the build budget on the request itself, not the pool's", () => {
    const pool = new mssql.ConnectionPool({ server: "unused", database: "unused" });

    // `Reflect.get` rather than a cast. The field is real and undeclared, so
    // reading it is the point — but a cast would ALSO silence the case where it
    // stops existing, which is exactly the regression this test is here to
    // catch. Reflect.get returns unknown and the assertions below do the
    // narrowing, so a missing field fails rather than reads as undefined.
    const overrides: unknown = Reflect.get(buildRequest(pool), "overrides");

    expect(overrides).toMatchObject({ requestTimeout: expect.any(Number) });
    // And it must be the build budget rather than the pool's read budget, which
    // is what would come back if the library ignored the second argument. Read
    // through Reflect again rather than narrowed with a cast: the assertion is
    // what says the number is there, and a cast would answer `undefined` for a
    // field that had gone.
    if (typeof overrides !== "object" || overrides === null) {
      throw new Error("the request carries no overrides at all");
    }
    expect(Reflect.get(overrides, "requestTimeout")).toBeGreaterThan(900_000);
  });
});
