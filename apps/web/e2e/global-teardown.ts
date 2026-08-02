import { Pool } from "pg";
import { E2E_EMAIL_PREFIX } from "./fixtures";

// The suite signs up real accounts and connects real clusters against a shared
// postgres. Without this they accumulate on every run — the same unbounded
// growth the job queue had, in the table a developer actually looks at.
//
// Scoped to the e2e email prefix so it can never touch the api integration
// suite's rows or a developer's own account. Cascades handle the org, its
// clusters and everything hanging off them.
export default async function globalTeardown(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") return;
  const pool = new Pool({ connectionString });
  try {
    const { rowCount } = await pool.query(`delete from "user" where email like $1`, [
      `${E2E_EMAIL_PREFIX}%`,
    ]);
    if (rowCount !== null && rowCount > 0) {
      console.log(`e2e teardown: removed ${rowCount} test account(s)`);
    }
  } finally {
    await pool.end();
  }
}
