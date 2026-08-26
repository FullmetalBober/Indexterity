import { scopeForDiagnosis } from "../engine/observe";
import type { ConnectionDiagnosis, DialProxy, PrivilegeCheck, TlsOverrides } from "../engine/ports";
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
    // A permission gap is closed by GRANTing to a principal this diagnosis cannot
    // name — the reader may be about to fix the login they pasted, or to let us
    // provision a different one — so there is no statement to hand over (#246).
    command: null,
  };
}

// 1000 MB, which is what SQL Server 2019 and later create a database with and what
// 2016 and 2017 do not: measured on real instances, a new 2017 database gets
// MAX_STORAGE_SIZE_MB = 100 with QUERY_CAPTURE_MODE = ALL, and a new 2022 database
// gets 1000 with AUTO (#246).
//
// So the statement below carries the size deliberately. A bare enable on the older
// generation turns on ALL capture into a 100 MB budget, and a full store flips to
// READ_ONLY and stops capturing — silently, which is the outcome this product must
// not hand somebody. Naming the newer default normalises the old generation onto it
// and changes nothing on a server that is already there.
//
// QUERY_CAPTURE_MODE is deliberately NOT set, even though the integration suite
// sets ALL: that line is there so the suite's own one-off seeded queries are
// captured deterministically. A production workload runs repeatedly and AUTO
// captures it, so pushing the more expensive mode onto a customer's server would be
// for a test's benefit rather than theirs.
const QUERY_STORE_MAX_STORAGE_MB = 1000;

// The Query Store check is not a permission but a server configuration: the
// workload and latency signals exist only where it is on. Reported in the same
// list so the connect form can show one story about what will and will not work.
//
// `off` is the databases in scope that have it disabled, and it is what makes this
// row actionable (#246): the probe reads `actual_state` per database anyway, so the
// check can hand over the exact statements instead of an ellipsis the reader has to
// expand once per database, having first worked out which ones they are.
//
// Three states, not two, and the third is why this takes a nullable list rather
// than a boolean plus a list. `[]` means asked, and enabled everywhere. A non-empty
// list means asked, and these are the ones missing it. `null` means never asked — an
// unreachable cluster or a version refusal — which has to report NOT granted with
// nothing to run. Passing `[]` there would draw a tick beside Query Store on a
// server that never answered.
// Exported for unit tests: the statements it builds are the ones a reader will
// paste into a query window on production, so they are worth pinning.
export function queryStoreCheck(off: readonly string[] | null): PrivilegeCheck {
  const statements =
    off === null || off.length === 0
      ? null
      : off
          .map(
            (database) =>
              `ALTER DATABASE ${quoteIdent(database)} SET QUERY_STORE = ON ` +
              `(OPERATION_MODE = READ_WRITE, MAX_STORAGE_SIZE_MB = ${QUERY_STORE_MAX_STORAGE_MB});`,
          )
          .join("\n");
  return {
    key: "queryStore",
    label: "Query Store enabled",
    enables:
      "read/write latency per table (the regression gates) and hinted-index detection — " +
      (statements === null
        ? "enable it per database with ALTER DATABASE … SET QUERY_STORE = ON"
        : `off on ${(off ?? []).join(", ")}. Run this as an owner of the server — the ` +
          "login Indexterity uses holds ALTER on schemas, not on the database, so it " +
          "cannot enable this itself"),
    tier: "WORKLOAD",
    granted: off !== null && off.length === 0,
    command: statements,
  };
}

// What this login holds and the engine never uses (#313).
//
// Three findings, each with the one statement that removes it. `sysadmin` is
// listed separately from CONTROL SERVER even though it implies it, because
// `REVOKE CONTROL SERVER` on a sysadmin changes nothing — the membership is what
// carries the permission, so it is the membership that has to be dropped.
//
// `db_owner` is per database and reported per database, with the DATABASE USER
// name rather than the login: `ALTER ROLE … DROP MEMBER` names the user, and a
// login's user is a different name in every database it has one in. That is why
// the probe reads USER_NAME() inside each database rather than reusing
// SUSER_SNAME() from the server-scoped query.
//
// Only what is HELD is returned. A row saying "you are not a sysadmin" is
// reassurance dressed as a finding, and three of them would bury the one that is
// real — the empty case is said once by the screen (#289).
export function evaluateMssqlSurplus(
  serverGrants: ReadonlySet<string>,
  perDb: ReadonlyMap<string, MssqlDatabaseGrants>,
  login: string | null,
): PrivilegeCheck[] {
  const checks: PrivilegeCheck[] = [];
  const principal = login === null ? null : quoteIdent(login);
  // A sysadmin is ONE finding, not three. Everything below is implied by the
  // membership and cannot be revoked while it stands: `HAS_PERMS_BY_NAME` reports
  // CONTROL SERVER as held after it has been revoked, and the login maps to `dbo`
  // in every database, so both of the rows below would carry a statement that
  // either does nothing or is refused outright (verified on 2022 — Msg 15405,
  // "Cannot use the special principal 'dbo'"). Naming the membership names the
  // cause; the reader runs one statement and the rest follow.
  const sysadmin = serverGrants.has("sysadmin");
  if (sysadmin) {
    checks.push({
      key: "surplus_sysadmin",
      label: "membership in sysadmin",
      enables:
        "everything on the instance — reading and rewriting every table, creating logins, and " +
        "every permission below implicitly. The engine uses none of it, and no REVOKE narrows " +
        "it: the membership is what carries the permissions, so dropping it is the only change " +
        "that does anything",
      tier: "SURPLUS",
      granted: true,
      command: principal === null ? null : `ALTER SERVER ROLE [sysadmin] DROP MEMBER ${principal};`,
    });
  }
  if (!sysadmin && serverGrants.has("CONTROL SERVER")) {
    checks.push({
      key: "surplus_controlServer",
      label: "CONTROL SERVER",
      enables:
        "every permission on the instance, including granting them onward. Needed once to " +
        "provision a scoped login; never needed by a stored connection",
      tier: "SURPLUS",
      granted: true,
      command: principal === null ? null : `REVOKE CONTROL SERVER FROM ${principal};`,
    });
  }
  const owned = sysadmin ? [] : [...perDb.entries()].filter(([, grants]) => grants.dbOwner);
  if (owned.length > 0) {
    checks.push({
      key: "surplus_dbOwner",
      label: `membership in db_owner on ${owned.map(([database]) => database).join(", ")}`,
      enables:
        "reading and rewriting every table in those databases. The engine needs ALTER on the " +
        "schemas that hold tables and nothing else — see the Alter indexes row above for what " +
        "is actually used",
      tier: "SURPLUS",
      granted: true,
      // One statement per database, and the USE is not optional: a database role
      // membership can only be changed from inside the database that holds it.
      command: owned.every(([, grants]) => grants.userName === null)
        ? null
        : owned
            .filter(([, grants]) => grants.userName !== null)
            .map(
              ([database, grants]) =>
                `USE ${quoteIdent(database)};\n` +
                `ALTER ROLE [db_owner] DROP MEMBER ${quoteIdent(grants.userName ?? "")};`,
            )
            .join("\n"),
    });
  }
  return checks;
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
      // null, not []: nothing was asked, so this must not read as enabled.
      queryStoreCheck(null),
    ],
    {
      reachable: false,
      message,
      username: null,
      authEnabled: false,
      canProvision: false,
      // Nothing was enumerated, so nothing can be claimed surplus either: empty
      // here means "we could not ask", not "there is none".
      surplus: [],
      // Nothing was enumerated, so there is nothing to offer boxes for.
      databases: [],
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
  // Membership in that database's `db_owner` (#313) — surplus, not a
  // requirement, so it is reported through `surplus` and never through the
  // tiers.
  readonly dbOwner: boolean;
  // What this login is CALLED inside that database, which is not the login name:
  // `ALTER ROLE db_owner DROP MEMBER` names the database user. Null when the
  // login has no user there, in which case it is not a member of anything either.
  readonly userName: string | null;
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
    checks: {
      viewState: false,
      alterEverySchema: false,
      alterAnyUser: false,
      dbOwner: false,
      userName: null,
    },
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
    // Asked INSIDE the database, for the same reason the schema probe below is:
    // `IS_ROLEMEMBER` resolves against the current database and answers NULL for
    // a role that does not exist in the one it is asked from, and `USER_NAME()`
    // is a different name in every database a login has a user in (#313).
    const ownerRows = await conn.query<{ dbOwner: number | null; userName: string | null }>(
      `EXEC ${quoteIdent(database)}.sys.sp_executesql N'SELECT
           IS_ROLEMEMBER(''db_owner'') AS dbOwner, USER_NAME() AS userName'`,
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
        dbOwner: ownerRows[0]?.dbOwner === 1,
        userName: ownerRows[0]?.userName ?? null,
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
  // Which databases the answer is about (#244) — see the mongo adapter's
  // diagnose for why this changes the verdict and not only the work. Here it
  // also changes the COST: every database in scope costs one HAS_PERMS_BY_NAME
  // round trip below, so a twelve-database server narrowed to one is eleven
  // fewer.
  observedDatabases?: readonly string[] | null,
  // Route the dial through a tunnel when this cluster needs one (#353).
  proxy?: DialProxy,
): Promise<ConnectionDiagnosis> {
  const conn = new MssqlConnection(
    connectionString,
    overrides,
    proxy === undefined ? undefined : { proxy },
  );
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
      sysadmin: number | null;
      login: string | null;
    }>(
      // `IS_SRVROLEMEMBER` rather than another HAS_PERMS_BY_NAME: sysadmin is a
      // MEMBERSHIP and not a permission, which is exactly why revoking permissions
      // from a sysadmin does nothing (#313). It answers NULL for a role name the
      // server does not know, which the comparison below treats as "no".
      `SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS viewServerState,
              HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY LOGIN') AS alterAnyLogin,
              HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER') AS controlServer,
              IS_SRVROLEMEMBER('sysadmin') AS sysadmin,
              SUSER_SNAME() AS login`,
    );
    const serverGrants = new Set<string>();
    const server = serverRows[0];
    if (server?.viewServerState === 1) serverGrants.add("VIEW SERVER STATE");
    if (server?.alterAnyLogin === 1) serverGrants.add("ALTER ANY LOGIN");
    if (server?.controlServer === 1) serverGrants.add("CONTROL SERVER");
    // In the same set as the permissions, and named so it cannot collide with
    // one: `evaluateMssqlPrivileges` only ever asks about the three above, so the
    // extra key is invisible to the tiers and visible to the surplus pass.
    if (server?.sysadmin === 1) serverGrants.add("sysadmin");
    const username = server?.login ?? null;

    const available = await conn.listDatabaseNames();
    // What the cluster HAS versus what this answer is about — the same split the
    // mongo adapter makes, through the same shared rule (engine/observe.ts): the
    // form draws its boxes from `available`, so narrowing that list would make a
    // database impossible to ever tick.
    const databases = scopeForDiagnosis(available, observedDatabases);
    const perDb = new Map<string, MssqlDatabaseGrants>();
    // WHICH databases are missing it, not just whether any are (#246). The probe
    // reads actual_state per database either way, so keeping the names is free —
    // and they are what turns "enable it per database" into statements the reader
    // can run.
    const queryStoreOff: string[] = [];
    for (const database of databases) {
      const grants = await databaseGrants(conn, database);
      perDb.set(database, grants.checks);
      if (!grants.queryStore) queryStoreOff.push(database);
    }

    const checks = evaluateMssqlPrivileges(serverGrants, perDb);
    // Named rather than counted. "at least one database" also meant at least one IN
    // SCOPE from #244 — a twelve-database instance with Query Store on for the
    // production database used to carry this warning about a database nobody was
    // going to observe — and from #246 it names them, because the reader's next
    // question was always which.
    const advisory =
      queryStoreOff.length === 0
        ? null
        : `Query Store is off on ${queryStoreOff.join(", ")} — latency gates and ` +
          "hinted-index detection are blind there until it is enabled (the statements " +
          "are under the Query Store row below)";
    return summarize([...checks, queryStoreCheck(queryStoreOff)], {
      reachable: true,
      message: advisory,
      surplus: evaluateMssqlSurplus(serverGrants, perDb, username),
      username,
      // SQL logins are always authenticated; integrated auth is not supported.
      authEnabled: true,
      databases: available,
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
