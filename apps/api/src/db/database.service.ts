import { Injectable } from "@nestjs/common";
import { requiredEnv } from "../env";
import { createDatabase, type Database } from "./client";

// Single shared Drizzle/Postgres connection for the control plane.
@Injectable()
export class DatabaseService {
  readonly db: Database = createDatabase(requiredEnv("DATABASE_URL"));
}
