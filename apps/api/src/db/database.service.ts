import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { coreEnv, workerEnv } from "../config/env";
import { drainPool } from "../jobs/connection-pool";
import { closeJobDb } from "../jobs/db";
import { closeDatabase, createDatabase, type Database } from "./client";

// Single shared Drizzle/Postgres connection for the control plane. On shutdown
// (enableShutdownHooks in main.ts) every pool this process opened is drained:
// this pg pool, the jobs' shared pg pool, and the mongo client pool.
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  // Capped from PG_POOL_MAX, like the other long-lived pools. Kept SEPARATE from
  // them on purpose: one pool shared with better-auth would let a slow report
  // starve a sign-in of a connection, and the isolation is worth more than the
  // handful of backends it costs.
  readonly db: Database = createDatabase(coreEnv().DATABASE_URL, workerEnv().PG_POOL_MAX);

  async onApplicationShutdown(): Promise<void> {
    await drainPool();
    await closeJobDb();
    await closeDatabase(this.db);
  }
}
