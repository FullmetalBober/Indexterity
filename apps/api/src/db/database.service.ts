import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import type { Pool, QueryResultRow } from "pg";
import { coreEnv, workerEnv } from "../config/env";
import { drainPool } from "../jobs/connection-pool";
import { closeDatabase, createDatabase, type Database } from "./client";

// The api's Drizzle/Postgres connection for the control plane, and now the only
// one this process opens for it: the jobs used to reach for a second pool of
// their own, and since the pipeline moved in (#231, #232) they run against this
// one instead.
//
// On shutdown (enableShutdownHooks in main.ts) both pools this process owns are
// drained: this one and the mongo client pool. Draining happens in
// onApplicationShutdown, one Nest phase AFTER beforeApplicationShutdown — which
// is where TickService settles any in-flight drain, so no job is still running
// against this pool when it closes (see the ordering note in jobs/tick.service.ts).
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  // Capped from PG_POOL_MAX, like the other long-lived pools. Kept SEPARATE from
  // them on purpose: one pool shared with better-auth would let a slow report
  // starve a sign-in of a connection, and the isolation is worth more than the
  // handful of backends it costs.
  readonly db: Database = createDatabase(coreEnv().DATABASE_URL, workerEnv().PG_POOL_MAX);

  // The pg Pool under the drizzle client, as the typed handle drizzle itself
  // exposes ($client carries the concrete Pool type through createDatabase).
  // The tick's drain hands this to graphile-worker's runOnce, which MUST reuse
  // it: given a connectionString instead, every tick would build and tear down
  // a fresh pool — a connection churn on a 30-second schedule (#229, risk 5).
  get pool(): Pool {
    return this.db.$client;
  }

  /**
   * One raw statement, as rows.
   *
   * A seam, and a narrow one on purpose. Drizzle's `execute` is declared to
   * return `PgRaw<…>` — a class with phantom generics, not a promise — so a test
   * fake resolving to `{ rows }`, which is what every caller here awaits, is
   * assignable to none of it and does not overlap enough for even a single
   * assertion. Seven test files were reaching for `as unknown as` to get past
   * that, and one shared helper to contain it.
   *
   * Awaiting inside is what removes the need: `await` unwraps the thenable and
   * the result is typed, so callers depend on `Promise<TRow[]>` — something a
   * fake can honestly be. Nothing here wanted a whole Database; it wanted rows.
   */
  // `TRow[]`, not drizzle's `Assume<TRow, QueryResultRow>[]`. The two are the
  // same type — `Assume<T, U>` is `T extends U ? T : U` and TRow is constrained
  // to QueryResultRow — but TypeScript defers the conditional while TRow is
  // still a type variable and cannot see it. Returning drizzle's version instead
  // would compile with no assertion and cost every caller its row types, which
  // is a worse trade than one narrowing the constraint above already proves.
  async rows<TRow extends QueryResultRow>(query: SQL): Promise<TRow[]> {
    const result = await this.db.execute<TRow>(query);
    return result.rows as TRow[];
  }

  async onApplicationShutdown(): Promise<void> {
    await drainPool();
    await closeDatabase(this.db);
  }
}
