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
    const request = buildRequest(pool) as unknown as {
      overrides?: { requestTimeout?: number };
    };

    // Whatever INDEX_BUILD_TIMEOUT_MS resolves to, it must be ON the request —
    // present and a number, rather than silently dropped by a library that
    // ignored the second argument.
    expect(typeof request.overrides?.requestTimeout).toBe("number");
    // And it must be the build budget rather than the pool's read budget, which
    // is what would come back if the override were ignored.
    expect(request.overrides?.requestTimeout).toBeGreaterThan(900_000);
  });
});
