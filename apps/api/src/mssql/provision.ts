import { randomBytes, randomInt } from "node:crypto";
import type { ProvisionedUser, TlsOverrides } from "../engine/ports";
import { ProvisionDeniedError } from "../mongo/provision";
import { parseMssqlConnString, withMssqlCredentials } from "./conn-string";
import { MssqlConnection, quoteIdent, quoteString } from "./connection";

// What the scoped login is granted, and why it is exactly this (#203). The
// mirror of mongo's ENGINE_PRIVILEGES, and the same contract: provisioning
// creates precisely what mssql/diagnose.ts probes, so a provisioned cluster
// always diagnoses clean.
//
//   VIEW SERVER STATE          sys.dm_db_index_usage_stats — server-scoped, so
//                              it is granted once on the login.
//   VIEW DATABASE STATE        sizes, row counts and Query Store, per database.
//   ALTER ON SCHEMA::<schema>  index DDL. Per SCHEMA rather than per database,
//                              and that choice is measured on 2022:
//
//                                database ALTER also permits CREATE TABLE,
//                                ALTER TABLE and DROP TABLE anywhere in the
//                                database (verified — a login with it dropped a
//                                table);
//                                schema ALTER permits index DDL and refuses
//                                CREATE TABLE, and its reach stops at the
//                                schema;
//                                object ALTER is narrower still and REFUSES
//                                DROP TABLE (Msg 3701) — but a table created
//                                afterwards is then invisible to the login
//                                entirely (absent from sys.tables, Msg 1088 on
//                                any DDL), which turns a new table into a
//                                silent blind spot rather than a loud one.
//
//                              There is no index-only permission to reach for:
//                              sys.fn_builtin_permissions lists no ALTER ANY
//                              INDEX at server, database or schema scope.
//
// Notably absent: SELECT. The login cannot read a single customer row — the
// server enforces it (verified: Msg 229 on a plain SELECT), which is the same
// promise the mongo role makes by omitting `find`.
export const MSSQL_SCOPED_GRANTS = {
  server: "VIEW SERVER STATE",
  database: "VIEW DATABASE STATE",
  schema: "ALTER",
} as const;

// A password that satisfies SQL Server's complexity policy by CONSTRUCTION
// rather than by luck: the policy wants three of four character classes, and a
// random base64 string can miss one. One character from each class, then random
// filler, then a shuffle.
function scopedPassword(): string {
  const classes = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "#$%*+-"];
  const alphabet = classes.join("");
  const chars = classes.map((set) => set[randomInt(set.length)] ?? "x");
  while (chars.length < 32) chars.push(alphabet[randomInt(alphabet.length)] ?? "x");
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}

// The failures that mean "these credentials may not do this", as the server
// spells them. 15247/15151 are permission denials on the DDL itself; 4613 is
// the one that only shows up half way through — a login holding ALTER ANY LOGIN
// can CREATE LOGIN and then fail to GRANT, because granting needs the
// permission WITH GRANT OPTION or CONTROL SERVER (verified: Msg 4613, "Grantor
// does not have GRANT permission").
// Matched on the permission wording only. "does not exist or you do not have
// permission" is the server's deliberately ambiguous refusal (Msg 15151 and
// friends) and belongs here; a bare "does not exist" does NOT — that is a bug
// on our side, and dressing it up as "your credentials cannot do this" would
// send the reader off to change a grant that was never the problem.
function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /permission was denied|does not have GRANT permission|permission denied|do not have permission|requires .* permission|are not allowed/i.test(
    message,
  );
}

const DENIED_MESSAGE =
  "these credentials cannot create a login and grant it what the engine needs — " +
  "creating the login needs ALTER ANY LOGIN, creating its user in each database needs " +
  "ALTER ANY USER, and granting VIEW SERVER STATE needs CONTROL SERVER (or sysadmin). " +
  "Grant those, or create a login yourself with VIEW SERVER STATE, VIEW DATABASE STATE " +
  "and ALTER on each schema, and connect with it instead";

// Schemas that own user tables, which are the only ones index DDL ever touches.
// A schema with no tables is not granted: it would widen the login for nothing.
async function schemasWithTables(conn: MssqlConnection, database: string): Promise<string[]> {
  const rows = await conn.query<{ name: string }>(
    `SELECT s.name AS name
     FROM ${quoteIdent(database)}.sys.schemas s
     WHERE EXISTS (
       SELECT 1 FROM ${quoteIdent(database)}.sys.tables t
       WHERE t.schema_id = s.schema_id AND t.is_ms_shipped = 0)
     ORDER BY s.name`,
  );
  return rows.map((row) => row.name);
}

// Run a statement in another database's context. CREATE USER and GRANT are
// database-scoped and have no three-part form, and `USE` cannot be issued on a
// pooled connection without leaking the context into the next borrower — so
// each statement is executed through that database's own sp_executesql
// (verified on 2022).
function inDatabase(database: string, statement: string): string {
  return `EXEC ${quoteIdent(database)}.sys.sp_executesql N${quoteString(statement)}`;
}

// Use an admin connection string ONCE to create a least-privilege login the
// engine will run as, and return that login's connection string. The admin
// string is never stored; a failed verification drops what was created.
// Granted across every user database on the instance, deliberately NOT narrowed to
// the observe selection (#244).
//
// The selection decides what Indexterity LOOKS AT; it does not decide what this
// login MAY look at, and keeping those two separate is what makes the selection
// editable. Narrowing the grants was tried and reverted: the grants are made once,
// from an admin string that is never stored, so a login provisioned for two
// databases of twelve could never be widened afterwards — ticking a third database
// was a dead end with no way out inside the product. Now every database that
// exists at provisioning time is readable, and changing the selection is a row in
// postgres rather than a privilege the customer has to go and grant.
//
// The cost, stated rather than buried: the login holds VIEW DATABASE STATE and
// ALTER on each table-holding schema in databases the owner excluded from
// observation. What it still cannot do anywhere is read a row — no SELECT is
// granted at any scope, and the server enforces it (Msg 229 on a plain SELECT,
// verified) — so the footprint is index metadata and index DDL on databases we do
// not touch, not access to their data.
//
// A database created AFTER provisioning still gets no user, because nothing here
// runs again — that is the residual gap, and it is handled where it surfaces
// rather than here: the collect skips a database it cannot reach
// (DatabaseInaccessibleError) and setObservedDatabases refuses to start observing
// one, naming the login.
export async function provisionMssqlScopedUser(
  adminUri: string,
  overrides?: TlsOverrides,
): Promise<ProvisionedUser> {
  const username = `idx_${randomBytes(6).toString("hex")}`;
  const password = scopedPassword();
  const admin = new MssqlConnection(adminUri, overrides);
  const created: string[] = [];
  try {
    await admin.connect();
    const databases = await admin.listDatabaseNames();
    try {
      // Both in master, explicitly. A server-scoped GRANT is refused anywhere
      // else — "Permissions at the server scope can only be granted when the
      // current database is master", Msg 4621 — and the context here is
      // whatever the admin string's initial database says, which is routinely
      // not master.
      await admin.execute(
        inDatabase(
          "master",
          `CREATE LOGIN ${quoteIdent(username)} WITH PASSWORD = ${quoteString(password)}`,
        ),
      );
      await admin.execute(
        inDatabase("master", `GRANT ${MSSQL_SCOPED_GRANTS.server} TO ${quoteIdent(username)}`),
      );
      for (const database of databases) {
        await admin.execute(
          inDatabase(
            database,
            `CREATE USER ${quoteIdent(username)} FOR LOGIN ${quoteIdent(username)}`,
          ),
        );
        created.push(database);
        await admin.execute(
          inDatabase(database, `GRANT ${MSSQL_SCOPED_GRANTS.database} TO ${quoteIdent(username)}`),
        );
        for (const schema of await schemasWithTables(admin, database)) {
          await admin.execute(
            inDatabase(
              database,
              `GRANT ${MSSQL_SCOPED_GRANTS.schema} ON SCHEMA::${quoteIdent(schema)} TO ${quoteIdent(username)}`,
            ),
          );
        }
      }
    } catch (error) {
      await dropScopedLogin(admin, username, created);
      if (isPermissionError(error)) throw new ProvisionDeniedError(DENIED_MESSAGE);
      throw error;
    }
    const connectionString = withMssqlCredentials(adminUri, username, password);
    // Prove the scoped credentials authenticate before anything is stored. A
    // login that cannot connect is worse than no provisioning at all: the admin
    // string is already gone by the time anyone would notice.
    const probe = new MssqlConnection(connectionString, overrides);
    try {
      await probe.connect();
      await probe.ping();
    } catch (error) {
      await dropScopedLogin(admin, username, created);
      throw error;
    } finally {
      await probe.close().catch(() => {});
    }
    return { connectionString, username };
  } finally {
    await admin.close().catch(() => {});
  }
}

// Undo a half-finished provision. A login cannot be dropped while a database
// user maps to it, so the users go first; every step is best-effort, because
// this runs while another error is already on its way up.
async function dropScopedLogin(
  admin: MssqlConnection,
  username: string,
  databases: readonly string[],
): Promise<void> {
  for (const database of databases) {
    await admin
      .execute(inDatabase(database, `DROP USER IF EXISTS ${quoteIdent(username)}`))
      .catch(() => {});
  }
  await admin.execute(inDatabase("master", `DROP LOGIN ${quoteIdent(username)}`)).catch(() => {});
}

// The username a SQL Server connection string authenticates as, or null. The
// twin of mongo's connStringUsername, and read for the same reason: rotation
// has to know whether the stored "this is a provisioned login" marker still
// describes the new string.
export function mssqlConnStringUsername(value: string): string | null {
  const parsed = parseMssqlConnString(value);
  if (parsed === null || parsed.user.length === 0) return null;
  return parsed.user;
}
