import type { ConnectionDiagnosis, PrivilegeCheck, TlsOverrides } from "../engine/ports";
import { asNumber, MssqlConnection, quoteIdent } from "./connection";
import { mssqlVersionRefusal } from "./version";

// What the engine needs from a SQL Server login, expressed as the permission
// each check probes with HAS_PERMS_BY_NAME — evaluated server-side, nothing
// written. The tiers mean what they mean everywhere: CORE = analysis is
// impossible without it, APPLY = read-only until granted, WORKLOAD = an
// optional signal source, PROVISION = whether these credentials could create
// the least-privilege login we would rather run as (#203).
interface MssqlRequiredPrivilege {
  readonly key: string;
  readonly label: string;
  readonly enables: string;
  readonly tier: "CORE" | "APPLY" | "WORKLOAD" | "PROVISION";
  // "server" probes at server scope, "everyDb" must hold on every user
  // database the login can see, and "everySchema" on every schema that owns
  // user tables in every one of them.
  readonly scope: "server" | "everyDb" | "everySchema";
  readonly permission: string;
}

export const MSSQL_REQUIRED_PRIVILEGES: readonly MssqlRequiredPrivilege[] = [
  {
    key: "viewServerState",
    label: "View server state",
    enables:
      "index usage counters (sys.dm_db_index_usage_stats) — the whole drop decision rests on these",
    tier: "CORE",
    scope: "server",
    permission: "VIEW SERVER STATE",
  },
  {
    key: "viewDatabaseState",
    label: "View database state",
    enables:
      "index sizes, row counts and Query Store — sizes feed ROI, Query Store feeds the regression gates",
    tier: "CORE",
    scope: "everyDb",
    permission: "VIEW DATABASE STATE",
  },
  {
    key: "alterOnDatabase",
    label: "Alter indexes",
    enables: "the disable step before any drop, the drop itself, and building recommended indexes",
    tier: "APPLY",
    // Probed per SCHEMA, which is what provisioning grants (mssql/provision.ts
    // explains why index DDL is not worth database-wide ALTER). A login holding
    // the broader database ALTER still passes: HAS_PERMS_BY_NAME answers with
    // implied permissions, so it reports 1 for every schema inside (verified).
    scope: "everySchema",
    permission: "ALTER",
  },
];

// Whether the ADMIN credentials on the connect form could create the scoped
// login — reported as checks and not only as `canProvision`, because a bare
// false renders as nothing and leaves "your login cannot create logins" and "we
// could not tell" looking identical (#86).
//
// Three, because provisioning fails in three different places, and the middle
// one only shows up half way through: ALTER ANY LOGIN creates the login,
// ALTER ANY USER creates its user in each database, and the GRANTS need
// CONTROL SERVER — a login with ALTER ANY LOGIN and a plain VIEW SERVER STATE
// creates the login happily and then fails with Msg 4613, "Grantor does not
// have GRANT permission" (verified on 2022). sysadmin satisfies all three, as
// HAS_PERMS_BY_NAME reports every permission granted for it.
export const MSSQL_PROVISION_PRIVILEGES: readonly MssqlRequiredPrivilege[] = [
  {
    key: "alterAnyLogin",
    label: "Create a login (ALTER ANY LOGIN)",
    enables: "creating the idx_… login Indexterity would run as",
    tier: "PROVISION",
    scope: "server",
    permission: "ALTER ANY LOGIN",
  },
  {
    key: "controlServer",
    label: "Grant server permissions (CONTROL SERVER)",
    enables: "granting that login VIEW SERVER STATE — the usage counters the whole drop rests on",
    tier: "PROVISION",
    scope: "server",
    permission: "CONTROL SERVER",
  },
  {
    key: "alterAnyUser",
    label: "Create database users (ALTER ANY USER)",
    enables: "creating that login's user, and its grants, in every database",
    tier: "PROVISION",
    scope: "everyDb",
    permission: "ALTER ANY USER",
  },
];

function toCheck(required: MssqlRequiredPrivilege, granted: boolean): PrivilegeCheck {
  return {
    key: required.key,
    label: required.label,
    enables: required.enables,
    tier: required.tier,
    granted,
  };
}

// The Query Store check is not a permission but a server configuration: the
// workload and latency signals exist only where it is on. Reported in the same
// list so the connect form can show one story about what will and will not work.
function queryStoreCheck(enabledEverywhere: boolean): PrivilegeCheck {
  return {
    key: "queryStore",
    label: "Query Store enabled",
    enables:
      "read/write latency per table (the regression gates) and hinted-index detection — " +
      "enable it per database with ALTER DATABASE … SET QUERY_STORE = ON",
    tier: "WORKLOAD",
    granted: enabledEverywhere,
  };
}

function summarize(
  privileges: PrivilegeCheck[],
  base: Omit<ConnectionDiagnosis, "privileges" | "ready" | "canApply" | "missing">,
): ConnectionDiagnosis {
  const missing = privileges
    .filter((check) => !check.granted && (check.tier === "CORE" || check.tier === "APPLY"))
    .map((check) => check.label);
  return {
    ...base,
    privileges,
    ready: privileges.filter((check) => check.tier === "CORE").every((check) => check.granted),
    canApply: privileges.filter((check) => check.tier === "APPLY").every((check) => check.granted),
    missing,
  };
}

function failure(message: string): ConnectionDiagnosis {
  return summarize(
    [
      ...MSSQL_REQUIRED_PRIVILEGES.map((required) => toCheck(required, false)),
      ...MSSQL_PROVISION_PRIVILEGES.map((required) => toCheck(required, false)),
      queryStoreCheck(false),
    ],
    {
      reachable: false,
      message,
      username: null,
      authEnabled: false,
      canProvision: false,
    },
  );
}

// One database's answers to the db-scoped probes.
export interface MssqlDatabaseGrants {
  readonly viewState: boolean;
  // Every schema that owns user tables passes the ALTER probe. A database with
  // no user tables has nothing to alter and nothing to fail.
  readonly alterEverySchema: boolean;
  readonly alterAnyUser: boolean;
}

// Pure evaluation over the probe rows, exported for unit tests. `perDb` maps
// database name → that database's answers.
export function evaluateMssqlPrivileges(
  serverGrants: ReadonlySet<string>,
  perDb: ReadonlyMap<string, MssqlDatabaseGrants>,
): PrivilegeCheck[] {
  const databases = [...perDb.values()];
  const holds = (required: MssqlRequiredPrivilege, db: MssqlDatabaseGrants): boolean => {
    if (required.permission === "ALTER ANY USER") return db.alterAnyUser;
    if (required.scope === "everySchema") return db.alterEverySchema;
    return db.viewState;
  };
  return [...MSSQL_REQUIRED_PRIVILEGES, ...MSSQL_PROVISION_PRIVILEGES].map((required) => {
    if (required.scope === "server") {
      return toCheck(required, serverGrants.has(required.permission));
    }
    return toCheck(required, databases.length > 0 && databases.every((db) => holds(required, db)));
  });
}

// One database's answers, and whether Query Store is on there.
//
// A database the login cannot enter at all answers "no" to everything rather
// than failing the whole diagnosis: that is exactly the shape of a database
// created AFTER provisioning — it is listed (VIEW ANY DATABASE is granted to
// public), our login has no user in it, and every statement against it comes
// back as Msg 916. Reporting it as missing privileges names the database that
// needs re-provisioning; failing the dial would have said "unreachable" about a
// server that is fine.
async function databaseGrants(
  conn: MssqlConnection,
  database: string,
): Promise<{ checks: MssqlDatabaseGrants; queryStore: boolean }> {
  const denied = {
    checks: { viewState: false, alterEverySchema: false, alterAnyUser: false },
    queryStore: false,
  };
  try {
    const rows = await conn.query<{
      viewState: number | null;
      alterAnyUser: number | null;
      queryStore: number | null;
    }>(
      `SELECT
         HAS_PERMS_BY_NAME(@db, 'DATABASE', 'VIEW DATABASE STATE') AS viewState,
         HAS_PERMS_BY_NAME(@db, 'DATABASE', 'ALTER ANY USER') AS alterAnyUser,
         (SELECT TOP 1 CASE WHEN actual_state > 0 THEN 1 ELSE 0 END
            FROM ${quoteIdent(database)}.sys.database_query_store_options) AS queryStore`,
      { db: database },
    );
    const row = rows[0];
    if (row === undefined) return denied;
    // The ALTER probe runs INSIDE the database, because a SCHEMA securable is
    // resolved in the current database and there is no way to name another one
    // in it — asked from master it answers 0 for a login that genuinely holds
    // the grant (verified on 2022, which is how this nearly shipped wrong).
    const schemaRows = await conn.query<{ missing: number }>(
      `EXEC ${quoteIdent(database)}.sys.sp_executesql N'SELECT COUNT(*) AS missing
         FROM sys.schemas s
         WHERE EXISTS (SELECT 1 FROM sys.tables t
                       WHERE t.schema_id = s.schema_id AND t.is_ms_shipped = 0)
           AND HAS_PERMS_BY_NAME(s.name, ''SCHEMA'', ''ALTER'') = 0'`,
    );
    return {
      checks: {
        viewState: row.viewState === 1,
        // No schema failing the probe is the answer we want — and a database
        // with no user tables reports none for the same reason: there is
        // nothing in it to alter.
        alterEverySchema: asNumber(schemaRows[0]?.missing) === 0,
        alterAnyUser: row.alterAnyUser === 1,
      },
      queryStore: row.queryStore === 1,
    };
  } catch {
    return denied;
  }
}

export async function diagnoseMssqlConnection(
  connectionString: string,
  overrides?: TlsOverrides,
): Promise<ConnectionDiagnosis> {
  const conn = new MssqlConnection(connectionString, overrides);
  try {
    await conn.connect();
    // Version first: below the floor nothing else matters, and saying so at
    // connect time beats a customer discovering weeks later that nothing drops.
    const refusal = mssqlVersionRefusal(await conn.serverVersion());
    if (refusal !== null) return failure(refusal);

    const serverRows = await conn.query<{
      viewServerState: number | null;
      alterAnyLogin: number | null;
      controlServer: number | null;
      login: string | null;
    }>(
      `SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS viewServerState,
              HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY LOGIN') AS alterAnyLogin,
              HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER') AS controlServer,
              SUSER_SNAME() AS login`,
    );
    const serverGrants = new Set<string>();
    const server = serverRows[0];
    if (server?.viewServerState === 1) serverGrants.add("VIEW SERVER STATE");
    if (server?.alterAnyLogin === 1) serverGrants.add("ALTER ANY LOGIN");
    if (server?.controlServer === 1) serverGrants.add("CONTROL SERVER");
    const username = server?.login ?? null;

    const databases = await conn.listDatabaseNames();
    const perDb = new Map<string, MssqlDatabaseGrants>();
    let queryStoreEverywhere = databases.length > 0;
    for (const database of databases) {
      const grants = await databaseGrants(conn, database);
      perDb.set(database, grants.checks);
      if (!grants.queryStore) queryStoreEverywhere = false;
    }

    const checks = evaluateMssqlPrivileges(serverGrants, perDb);
    const advisory = queryStoreEverywhere
      ? null
      : "Query Store is off on at least one database — latency gates and hinted-index " +
        "detection are blind there until ALTER DATABASE … SET QUERY_STORE = ON";
    return summarize([...checks, queryStoreCheck(queryStoreEverywhere)], {
      reachable: true,
      message: advisory,
      username,
      // SQL logins are always authenticated; integrated auth is not supported.
      authEnabled: true,
      canProvision: checks
        .filter((check) => check.tier === "PROVISION")
        .every((check) => check.granted),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/login failed/i.test(message)) {
      return failure("authentication failed — check the username and password.");
    }
    if (/ESOCKET|ETIMEOUT|ECONNREFUSED|getaddrinfo|Failed to connect/i.test(message)) {
      return failure("server unreachable — check the host, port and network access.");
    }
    return failure(message);
  } finally {
    await conn.close().catch(() => {});
  }
}
