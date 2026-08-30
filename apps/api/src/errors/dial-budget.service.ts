import { Inject, Injectable } from "@nestjs/common";
import { ORPCError } from "@orpc/server";
import type { SQL } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { sql } from "../db";
import { DatabaseService } from "../db/database.service";

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

// Its own code rather than the bare 429 it rides on (#162), the way
// `PLAN_LIMIT` is its own code rather than a bare 402.
//
// Every other 429 this product answers is better-auth's per-address rate limit,
// which means "you are going too fast" and comes back on a clock the reader can
// guess. This one is per ACCOUNT and exists because the control plane dials
// hosts the caller names — a security control, not a throttle — so someone who
// typos a connection string a few times and someone sweeping a network hit the
// same refusal. It has to say which limit it was.
//
// The dashboard reads the code, not the status: `apiMessage` shows the api's own
// words for this refusal whatever readable-status list the call site passed,
// because all four routes that dial narrow that list to their own failures
// (web/src/lib/queries/errors.ts).
export const DIAL_BUDGET_CODE = "DIAL_BUDGET";

// The budget, as a provider (#354). It holds the pool because the count lives in
// postgres — see the note above for why it is not in memory.
/** The one row this service reads back. */
export interface BudgetRow extends QueryResultRow {
  count: number;
  seconds_left: number;
}

/**
 * The one thing the budget asks of the database: rows from one statement.
 *
 * Fixed to `BudgetRow` rather than generic on the method. A generic `rows<T>`
 * promises rows of whatever type the caller asks for, and the only value
 * assignable to `T[]` for every `T` is `[]` — so a fake carrying real data has
 * to assert. Fixed here, the fake just answers BudgetRows, and
 * `DatabaseService.rows` still satisfies it.
 */
export interface RowReader {
  rows(query: SQL): Promise<BudgetRow[]>;
}

@Injectable()
export class DialBudgetService {
  // Token is the class, type is the port — see tick.controller.ts for what a
  // bare interface costs here (Nest resolves from runtime metadata).
  constructor(@Inject(DatabaseService) private readonly database: RowReader) {}

  // Atomic in a single statement: the window either rolls over or increments, so
  // concurrent requests across replicas cannot both read a stale count.
  async consume(userId: string): Promise<void> {
    const rows = await this.database.rows(sql`
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
    const row = rows[0];
    if (row === undefined) return;
    if (Number(row.count) > MAX_DIALS) {
      const seconds = Math.max(1, Number(row.seconds_left));
      // Names the budget, its clock and when it comes back, all three read off the
      // constants above so the sentence cannot drift from the rule it describes.
      // "Try again later" was what a reader got before, from a window that is
      // actually a minute long — so the refusal read as permanent and arrived as a
      // support question.
      throw new ORPCError(DIAL_BUDGET_CODE, {
        status: 429,
        message: `connection attempts are limited to ${MAX_DIALS} every ${WINDOW_SECONDS}s per account — try again in ${seconds}s`,
      });
    }
  }

  // Test seam: clear every window. No caller today — kept because the table has
  // no other way back to empty and a suite that needs one should not have to
  // reach for raw SQL, but it is dead weight and worth deleting if it stays that
  // way.
  async reset(): Promise<void> {
    await this.database.rows(sql`delete from dial_budgets`);
  }
}
