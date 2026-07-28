import { createDatabase, type Database } from "../db";
import { requiredEnv } from "../env";

// One shared pg pool per process. Jobs run repeatedly — a fresh pool per run
// (the old pattern) leaks connections until postgres runs out.
let shared: Database | null = null;

export function jobDb(): Database {
  shared ??= createDatabase(requiredEnv("DATABASE_URL"));
  return shared;
}
