import { describe, expect, it, vi } from "vitest";
import { buildMssqlPool, mssqlConfig, POOL_ACQUIRE_TIMEOUT_MS } from "./client";
import { parseMssqlConnString } from "./conn-string";

const STRING = "mssql://sa:pw@db.example.com:1433/app";

function parsed() {
  const value = parseMssqlConnString(STRING);
  if (value === null) throw new Error("fixture string did not parse");
  return value;
}

describe("the customer pool's error listener", () => {
  // Pinned here because the failure it prevents is invisible locally and
  // arrives AFTER everything looks handled. Measured against SQL Server 2022
  // for #424: kill the server with a request in flight and the query rejects
  // cleanly (`RequestError: socket hang up`), then ~1ms later tedious
  // dispatches a late `socketError` into a connection already in state
  // 'Final' and node-mssql re-emits it on the pool — which, unlisted, exits
  // the process. The same probe with this listener attached survives.
  //
  // The two IDLE cases pg needed handling for do NOT reproduce here (server
  // stopped under an idle pooled connection, and `KILL <spid>` on it with the
  // session verified gone afterwards): tedious emitted nothing at all. So one
  // listener, and client.ts says why the second would have nothing to attach to.
  it("attaches a pool-level error listener", () => {
    expect(buildMssqlPool(parsed()).listenerCount("error")).toBeGreaterThan(0);
  });

  it("makes an emitted error non-fatal instead of an uncaught exception", () => {
    const pool = buildMssqlPool(parsed());
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // An EventEmitter with no 'error' listener THROWS here. That throw is the
    // crash, so this asserting nothing-thrown is the regression.
    expect(() =>
      pool.emit("error", new Error("No event 'socketError' in state 'Final'")),
    ).not.toThrow();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("cluster mssql pool"));
    logged.mockRestore();
  });
});

// #454. tarn's default acquire timeout is 30 s and node-mssql leaves it there; a
// statement queued behind four Query Store scans waited that long and the pass
// failed with tarn's "operation timed out for an unknown reason". A wait may
// legitimately last as long as the statements ahead of it, so it gets the
// statement budget.
describe("the customer pool's acquire timeout", () => {
  it("is the statement budget, set explicitly", () => {
    const config = mssqlConfig(parsed());
    expect(config.pool?.acquireTimeoutMillis).toBe(POOL_ACQUIRE_TIMEOUT_MS);
    expect(config.pool?.acquireTimeoutMillis).toBe(config.requestTimeout);
  });
});
