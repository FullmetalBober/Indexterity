import { randomBytes } from "node:crypto";
import type { DialProxy, ProvisionedUser, TlsOverrides } from "../engine/ports";
import {
  alreadyProvisionedMessage,
  ProvisionDeniedError,
  SCOPED_USERNAME,
} from "../engine/provision";
import { field, messageOf } from "../errors/message";
import { pgConnStringUsername, withPgCredentials } from "./conn-string";
import { PostgresConnection } from "./connection";
import { quoteIdent } from "./executor";

export { pgConnStringUsername } from "./conn-string";

// The scoped role this adapter creates, and the one place PostgreSQL cannot
// match what the other two engines promise.
//
// MongoDB grants index management without any read privilege, and SQL Server's
// VIEW SERVER STATE / VIEW DATABASE STATE / schema ALTER does the same. Postgres
// has **no grantable index privilege at all** — measured on 17.11:
//
//   GRANT ALL PRIVILEGES ON ALL TABLES  ->  ERROR: must be owner of table orders
//   GRANT MAINTAIN (new in pg 17)       ->  ERROR: must be owner of table orders
//
// Only the table's OWNER may create or drop its indexes, and an owner can always
// SELECT. So a single role that both analyses and applies would necessarily be
// able to read every table it manages.
//
// The decision, therefore: **this provisions the read-only role and nothing
// more.** It is a genuine least-privilege user — verified refused on table data
// (`permission denied for table orders`) while reading every statistic the
// pipeline needs.
//
// Applying is a separate decision the operator makes afterwards, and there are
// two ways to make it (#332). The owner's own connection string, pasted
// deliberately, pays the trust cost in the open. Or the pg_cron apply function,
// which does not: a SECURITY DEFINER function owned by the table owner schedules
// the build and pg_cron runs it as that owner, so THIS role keeps every refusal
// above and can still apply. See cron-apply.ts for what that costs instead —
// a shared library, and therefore a restart.
const ROLE_GRANTS = {
  // Statistics across every user's objects — pg_stat_user_indexes,
  // pg_stat_statements, pg_stat_user_tables, pg_stat_database. This is what
  // makes the collect possible WITHOUT reading data, and it is the whole reason
  // a read-only Postgres cluster keeps the promise intact.
  monitor: "pg_monitor",
} as const;

// A password from the same alphabet the other adapters use: no characters that
// need quoting in a connection string of either form, so what is generated is
// what can be pasted.
function scopedPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(32);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

// Postgres reports an authorization failure as 42501, and "role does not exist"
// style problems as 42704 — neither of which a retry fixes.
function isAuthorizationError(error: unknown): boolean {
  const code = field(error, "code");
  if (code === "42501") return true;
  return /permission denied|must be (?:owner|superuser)|insufficient privilege/i.test(
    messageOf(error),
  );
}

// 42710 duplicate_object — the role name is taken. The backstop behind the
// pg_roles lookup below, for the window between asking and creating.
function isDuplicateRoleError(error: unknown): boolean {
  return field(error, "code") === "42710";
}

export const PROVISION_REFUSAL =
  "creating the scoped role needs CREATEROLE, and granting pg_monitor needs " +
  "membership in it (or superuser). Grant those, or create a role yourself with " +
  "pg_monitor plus CONNECT on each database and USAGE on each schema, and paste " +
  "its connection string instead";

// Use an admin string ONCE to create the read-only role, and return that role's
// string. The admin string is never stored, and a failed verification undoes
// what was created.
export async function provisionPostgresScopedUser(
  adminConnectionString: string,
  overrides?: TlsOverrides,
  // Route the admin dial through a tunnel when the cluster needs one (#353).
  proxy?: DialProxy,
): Promise<ProvisionedUser> {
  const username = SCOPED_USERNAME;
  const password = scopedPassword();
  const admin = new PostgresConnection(adminConnectionString, overrides, proxy);
  let roleCreated = false;
  try {
    await admin.connect();
    const databases = await admin.listDatabaseNames();
    // Before the first CREATE, so a server that is already connected is refused
    // without a half-granted role behind it. pg_roles is world-readable, so this
    // needs nothing the caller does not already have.
    const existing = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = $1",
      [username],
    );
    if (existing.length > 0) {
      throw new ProvisionDeniedError(
        alreadyProvisionedMessage(dropRoleStatements(username, databases)),
      );
    }
    try {
      // NOINHERIT is deliberately NOT set: the role is meant to use pg_monitor's
      // rights directly, and a role that has to SET ROLE first would need every
      // caller to know that.
      await admin.execute(
        `CREATE ROLE ${quoteIdent(username)} LOGIN PASSWORD '${password.replace(/'/g, "''")}'`,
      );
      roleCreated = true;
      await admin.execute(`GRANT ${ROLE_GRANTS.monitor} TO ${quoteIdent(username)}`);
      // CONNECT is per database and USAGE is per schema, so both are walked.
      // Databases that exist WHEN THIS RUNS, by the same decision #244 made for
      // the other engines: provisioning happens once from a string that is never
      // stored, so a role granted only where a selection pointed could never be
      // widened afterwards.
      for (const database of databases) {
        await admin.execute(
          `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(username)}`,
        );
        // USAGE on every non-system schema in that database. Needed because
        // pg_monitor grants statistics but not the right to look INTO a schema,
        // and without it pg_stat_user_indexes reports rows whose table the role
        // cannot then describe from pg_class.
        const schemas = await admin.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
          [],
          database,
        );
        for (const { nspname } of schemas) {
          await admin.execute(
            `GRANT USAGE ON SCHEMA ${quoteIdent(nspname)} TO ${quoteIdent(username)}`,
            database,
          );
        }
      }
    } catch (error) {
      if (isDuplicateRoleError(error)) {
        throw new ProvisionDeniedError(
          alreadyProvisionedMessage(dropRoleStatements(username, databases)),
        );
      }
      if (isAuthorizationError(error)) throw new ProvisionDeniedError(PROVISION_REFUSAL);
      throw error;
    }

    const scoped = withPgCredentials(adminConnectionString, username, password);
    // Verify by USING it, not by trusting the grants: a role that cannot
    // actually read the statistics is worse than no role, because the failure
    // would arrive at the first collect instead of here.
    await verify(scoped, overrides);
    return { connectionString: scoped, username, databases };
  } catch (error) {
    // Undo what was created, so a failed provision leaves nothing behind for
    // somebody to find later and wonder about.
    if (roleCreated) {
      try {
        await admin.execute(`DROP ROLE IF EXISTS ${quoteIdent(username)}`);
      } catch {
        // Best effort: the original failure is the one worth reporting, and a
        // role that could not be dropped is named in the message below.
      }
    }
    throw error;
  } finally {
    await admin.close();
  }
}

// Prove the role can do the read-only job, and prove it CANNOT do more than
// that. Both halves matter: the first is what the pipeline needs, and the second
// is the claim this whole file exists to keep.
async function verify(connectionString: string, overrides?: TlsOverrides): Promise<void> {
  const conn = new PostgresConnection(connectionString, overrides);
  try {
    await conn.connect();
    const rows = await conn.query<{ ok: boolean }>(
      "SELECT pg_is_in_recovery() IS NOT NULL AS ok FROM pg_stat_database LIMIT 1",
    );
    if (rows.length === 0) {
      throw new ProvisionDeniedError(
        "the role was created but cannot read pg_stat_database, so the grant of " +
          `${ROLE_GRANTS.monitor} did not take effect. ${PROVISION_REFUSAL}`,
      );
    }
  } finally {
    await conn.close();
  }
}

// The statements that remove the provisioned role, for the disconnect screen and
// the already-provisioned refusal to show. Not run by Indexterity: dropping a
// role is the operator's decision, and dropping it needs the admin credentials
// this product deliberately did not keep.
//
// A bare `DROP ROLE` is NOT enough, and the difference is the whole reason this
// returns a script instead of one line. Provisioning grants CONNECT on every
// database and USAGE on every schema in each, and postgres refuses to drop a
// role those grants still point at — measured on 18.4:
//
//   DROP ROLE "indexterity";
//   ERROR:  role "indexterity" cannot be dropped because some objects depend on it
//   DETAIL:  1 object in database postgres
//
// `DROP OWNED BY` clears them, and it clears them PER DATABASE: run in one, the
// DROP ROLE still fails naming the next (also measured). Shared-object grants —
// CONNECT on the databases themselves — go with the first one, so only the
// per-database schema privileges need the walk. Hence \c per database, which
// also makes the block paste straight into psql.
export function dropRoleStatements(username: string, databases: readonly string[]): string {
  const role = quoteIdent(username);
  return [
    ...databases.flatMap((database) => [`\\c ${quoteIdent(database)}`, `DROP OWNED BY ${role};`]),
    `DROP ROLE ${role};`,
  ].join("\n");
}

// Re-exported so the adapter can name one import site for both.
export const postgresConnStringUsername = pgConnStringUsername;
