import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { coreEnv, workerEnv } from "../config/env";
import { drainPool } from "../jobs/connection-pool";
import { closeDatabase, createDatabase, type Database } from "./client";

// The api's Drizzle/Postgres connection for the control plane, and now the only
// one this process opens for it: the jobs used to reach for a second pool of their
// own, and with RUN_WORKER=true they run against this one instead (main.ts).
//
// On shutdown (enableShutdownHooks in main.ts) both pools this process owns are
// drained: this one and the mongo client pool. The embedded runner is stopped
// first, by the handler that started it — see the ordering note in main.ts.
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  // Capped from PG_POOL_MAX, like the other long-lived pools. Kept SEPARATE from
  // them on purpose: one pool shared with better-auth would let a slow report
  // starve a sign-in of a connection, and the isolation is worth more than the
  // handful of backends it costs.
  readonly db: Database = createDatabase(coreEnv().DATABASE_URL, workerEnv().PG_POOL_MAX);

  async onApplicationShutdown(): Promise<void> {
    await drainPool();
    await closeDatabase(this.db);
  }
}
