import { coreEnv, workerEnv } from "../config/env";
import { createDatabase, type Database } from "../db";

// One shared pg pool per process. Jobs run repeatedly — a fresh pool per run
// (the old pattern) leaks connections until postgres runs out.
let shared: Database | null = null;

export function jobDb(): Database {
  // PG_POOL_MAX is per pool, and WORKER_CONCURRENCY is what makes this one ask
  // for more than a single connection at a time — raise them together.
  shared ??= createDatabase(coreEnv().DATABASE_URL, workerEnv().PG_POOL_MAX);
  return shared;
}

export async function closeJobDb(): Promise<void> {
  if (shared === null) return;
  await shared.$client.end();
  shared = null;
}
