import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

// Drain the underlying pg pool (graceful shutdown).
export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end();
}
