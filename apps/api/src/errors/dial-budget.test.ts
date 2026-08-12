import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { Database } from "../db";
import { consumeDialBudget, DIAL_BUDGET_CODE } from "./dial-budget";

// The upsert is one statement and its arithmetic is the database's (the
// integration suite exercises that against real postgres, "rate-limits dialing so
// the guard cannot be brute-forced"). What is worth pinning here is the refusal
// itself, because it is the part a reader sees: its code, which is how the
// dashboard tells this apart from the per-address rate limit, and its message,
// which has to name the limit and when it comes back.
function budgetAt(count: number, secondsLeft: number): Database {
  return {
    execute: async () => ({ rows: [{ count, seconds_left: secondsLeft }] }),
  } as unknown as Database;
}

describe("consumeDialBudget", () => {
  it("allows the attempt that spends the last unit", async () => {
    await expect(consumeDialBudget(budgetAt(10, 41), "user-1")).resolves.toBeUndefined();
  });

  it("refuses the one after it under its own code, not a bare 429", async () => {
    const error = await consumeDialBudget(budgetAt(11, 41), "user-1").catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(DIAL_BUDGET_CODE);
    expect((error as ORPCError<string, unknown>).status).toBe(429);
  });

  // The whole of #162: "too many connection attempts" left a reader with no way
  // to tell a typo from a lockout, and nothing said the window is a minute.
  it("names the limit, its window and when the next attempt is allowed", async () => {
    const error = await consumeDialBudget(budgetAt(11, 41), "user-1").catch(
      (thrown: unknown) => thrown,
    );
    expect((error as Error).message).toBe(
      "connection attempts are limited to 10 every 60s per account — try again in 41s",
    );
  });

  // `ceil` on a window that has just expired can hand back 0, and "try again in
  // 0s" reads as a refusal with no way out of it.
  it("never promises a retry in zero seconds", async () => {
    const error = await consumeDialBudget(budgetAt(11, 0), "user-1").catch(
      (thrown: unknown) => thrown,
    );
    expect((error as Error).message).toContain("try again in 1s");
  });

  // A budget row that did not come back is not evidence of a spent budget. The
  // guard behind this one is the network guard, not this count.
  it("lets the dial through when the upsert returned nothing", async () => {
    const empty = { execute: async () => ({ rows: [] }) } as unknown as Database;
    await expect(consumeDialBudget(empty, "user-1")).resolves.toBeUndefined();
  });
});
