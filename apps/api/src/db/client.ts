import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

// `max` is required rather than defaulted, because pg's own default of 10 was
// what every call site here was accepting by omission — and there are three
// long-lived pools in one api process (this one through DatabaseService, the
// jobs' shared pool, and better-auth's), so the process was quietly entitled to
// thirty postgres backends. Each backend costs memory on the DATABASE server,
// and a self-hosted postgres ships max_connections=100.
//
// Naming it per call site keeps that visible: a short-lived migration wants two,
// a request pool wants what its concurrency needs. Too low shows up as latency
// rather than errors — pg queues a request until a connection frees — so the
// symptom of getting this wrong is slow, not broken.
export function createDatabase(connectionString: string, max: number) {
  const pool = new Pool({ connectionString, max });
  return drizzle(pool, { schema });
}

// Drain the underlying pg pool (graceful shutdown).
export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end();
}
