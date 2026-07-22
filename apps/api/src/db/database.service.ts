import { Injectable } from "@nestjs/common";
import { createDatabase, type Database } from "@repo/db";
import { requiredEnv } from "../env";

// Single shared Drizzle/Postgres connection for the control plane.
@Injectable()
export class DatabaseService {
  readonly db: Database = createDatabase(requiredEnv("DATABASE_URL"));
}
