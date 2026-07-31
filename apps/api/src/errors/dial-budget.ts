import { ORPCError } from "@orpc/server";
import { type Database, sql } from "../db";

// Per-user budget for endpoints that make the control plane dial a
// customer-supplied host. The network guard blocks internal targets; this
// limits how fast someone can sweep external ones, and caps the outbound
// connection load one account can generate.
//
// Held in Postgres, not memory. In memory the ceiling was really N × MAX for N
// api replicas, and every deploy handed the budget back — for a control that
// exists to slow down a host sweep, both are the wrong failure mode. One
// upsert per connect attempt is cheap next to the dial it is guarding.

const WINDOW_SECONDS = 60;
const MAX_DIALS = 10;

// Atomic in a single statement: the window either rolls over or increments, so
// concurrent requests across replicas cannot both read a stale count.
export async function consumeDialBudget(db: Database, userId: string): Promise<void> {
  const result = await db.execute<{ count: number; seconds_left: number }>(sql`
    insert into dial_budgets (user_id, count, reset_at)
    values (${userId}, 1, now() + make_interval(secs => ${WINDOW_SECONDS}))
    on conflict (user_id) do update set
      count = case when dial_budgets.reset_at <= now() then 1 else dial_budgets.count + 1 end,
      reset_at = case
        when dial_budgets.reset_at <= now() then now() + make_interval(secs => ${WINDOW_SECONDS})
        else dial_budgets.reset_at
      end
    returning count, ceil(extract(epoch from (reset_at - now())))::int as seconds_left
  `);
  const row = result.rows[0];
  if (row === undefined) return;
  if (Number(row.count) > MAX_DIALS) {
    const seconds = Math.max(1, Number(row.seconds_left));
    throw new ORPCError("TOO_MANY_REQUESTS", {
      status: 429,
      message: `too many connection attempts — try again in ${seconds}s`,
    });
  }
}

// Test seam: clear every window.
export async function resetDialBudgets(db: Database): Promise<void> {
  await db.execute(sql`delete from dial_budgets`);
}
