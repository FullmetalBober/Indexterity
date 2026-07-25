import { Injectable } from "@nestjs/common";
import { createDatabase, type Database } from "./client";
import { requiredEnv } from "../env";

// Single shared Drizzle/Postgres connection for the control plane.
@Injectable()
export class DatabaseService {
  readonly db: Database = createDatabase(requiredEnv("DATABASE_URL"));
}
