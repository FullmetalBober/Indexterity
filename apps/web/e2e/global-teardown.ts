import { Pool } from "pg";
import { E2E_EMAIL_PREFIX, E2E_ORG_PREFIX } from "./fixtures";

// The suite signs up real accounts and connects real clusters against a shared
// postgres. Without this they accumulate on every run — the same unbounded
// growth the job queue had, in the table a developer actually looks at.
//
// Scoped to the e2e prefixes so it can never touch the api integration suite's
// rows or a developer's own account.
//
// Two deletes, not one. `organizations` has no foreign key to `user` — an org
// outlives its last member on purpose, since removing somebody must not take the
// team's clusters with them — so deleting the accounts leaves the orgs behind.
// They go first, and cascades take their clusters and everything under those.
export default async function globalTeardown(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") return;
  const pool = new Pool({ connectionString });
  try {
    const orgs = await pool.query(`delete from organizations where name like $1`, [
      `${E2E_ORG_PREFIX}%`,
    ]);
    const users = await pool.query(`delete from "user" where email like $1`, [
      `${E2E_EMAIL_PREFIX}%`,
    ]);
    const removed = (orgs.rowCount ?? 0) + (users.rowCount ?? 0);
    if (removed > 0) {
      console.log(
        `e2e teardown: removed ${users.rowCount ?? 0} test account(s) and ${orgs.rowCount ?? 0} organization(s)`,
      );
    }
  } finally {
    await pool.end();
  }
}
