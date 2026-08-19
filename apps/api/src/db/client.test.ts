import { describe, expect, it } from "vitest";
import { createDatabase } from "./client";

// A pool bound is the kind of setting that is easy to write and easy to have no
// effect — pass it under the wrong key and pg keeps its own default of 10 — so
// this reads it back off the pool rather than trusting the call.
//
// It matters more than one number suggests: three long-lived pools live in one api
// process (this one through DatabaseService, the jobs' shared pool, and
// better-auth's), each capped by PG_POOL_MAX, and every connection is a backend
// on the DATABASE server. A self-hosted postgres ships max_connections=100.
//
// No connection is opened here. `new Pool` is lazy — it connects on the first
// query — so this needs no postgres, which is why it can be a unit test at all.
const URL = "postgres://u:p@localhost:5432/db";

describe("createDatabase", () => {
  it("caps the pool at what it was given, not at pg's default of 10", () => {
    const db = createDatabase(URL, 5);
    expect(db.$client.options.max).toBe(5);
  });

  it("takes the small bound a one-shot command wants", () => {
    // migrate.js, rotate-key.js and set-plan.js all pass 2: they run in sequence
    // and exit, so a pool sized for serving would open connections it never uses.
    expect(createDatabase(URL, 2).$client.options.max).toBe(2);
  });

  it("holds nothing open until something asks", () => {
    // The bound is a ceiling, not a reservation — an idle api replica costs the
    // database nothing, which is what makes capping cheap rather than a trade.
    const db = createDatabase(URL, 5);
    expect(db.$client.totalCount).toBe(0);
    expect(db.$client.idleCount).toBe(0);
  });

  // Pinned here because the failure these prevent is invisible locally: an idle
  // client dying emits 'error' on the Pool, and with no listener that is an
  // uncaught exception — a crash only a flaky network would ever demonstrate.
  // graphile-worker checks exactly these two listener counts (lib.js
  // assertPool) and warns into the log when either is zero, which the kind
  // test's clean-logs rule turns into a CI failure; this keeps the regression a
  // unit failure instead.
  it("attaches the pool-level and per-client error listeners", () => {
    const db = createDatabase(URL, 5);
    expect(db.$client.listenerCount("error")).toBeGreaterThan(0);
    expect(db.$client.listenerCount("connect")).toBeGreaterThan(0);
  });
});
