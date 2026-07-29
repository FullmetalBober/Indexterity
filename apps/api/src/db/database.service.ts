import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { requiredEnv } from "../env";
import { drainPool } from "../jobs/connection-pool";
import { closeJobDb } from "../jobs/db";
import { closeDatabase, createDatabase, type Database } from "./client";

// Single shared Drizzle/Postgres connection for the control plane. On shutdown
// (enableShutdownHooks in main.ts) every pool this process opened is drained:
// this pg pool, the jobs' shared pg pool, and the mongo client pool.
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly db: Database = createDatabase(requiredEnv("DATABASE_URL"));

  async onApplicationShutdown(): Promise<void> {
    await drainPool();
    await closeJobDb();
    await closeDatabase(this.db);
  }
}
