import type { ConnectionDiagnosis, PrivilegeCheck, TlsOverrides } from "../engine/ports";
import { MssqlConnection, quoteIdent } from "./connection";
import { mssqlVersionRefusal } from "./version";

// What the engine needs from a SQL Server login, expressed as the permission
// each check probes with HAS_PERMS_BY_NAME — evaluated server-side, nothing
// written. The tiers mean what they mean everywhere: CORE = analysis is
// impossible without it, APPLY = read-only until granted, WORKLOAD = an
// optional signal source. No PROVISION checks in v1: the adapter does not
// provision scoped logins yet (EngineCapabilities.provisionScopedUsers), and a
// missing capability is not a missing privilege.
interface MssqlRequiredPrivilege {
  readonly key: string;
  readonly label: string;
  readonly enables: string;
  readonly tier: "CORE" | "APPLY" | "WORKLOAD";
  // "server" probes at server scope, "everyDb" must hold on every user
  // database the login can see.
  readonly scope: "server" | "everyDb";
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
    scope: "everyDb",
    permission: "ALTER",
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

// Pure evaluation over the probe rows, exported for unit tests. `perDb` maps
// database name → the two db-scoped answers for it.
export function evaluateMssqlPrivileges(
  serverGrants: ReadonlySet<string>,
  perDb: ReadonlyMap<string, { viewState: boolean; alter: boolean }>,
): PrivilegeCheck[] {
  const databases = [...perDb.values()];
  return MSSQL_REQUIRED_PRIVILEGES.map((required) => {
    if (required.scope === "server") {
      return toCheck(required, serverGrants.has(required.permission));
    }
    const granted =
      databases.length > 0 &&
      databases.every((db) => (required.permission === "ALTER" ? db.alter : db.viewState));
    return toCheck(required, granted);
  });
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

    const serverRows = await conn.query<{ granted: number | null; login: string | null }>(
      `SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS granted,
              SUSER_SNAME() AS login`,
    );
    const serverGrants = new Set<string>();
    if (serverRows[0]?.granted === 1) serverGrants.add("VIEW SERVER STATE");
    const username = serverRows[0]?.login ?? null;

    const databases = await conn.listDatabaseNames();
    const perDb = new Map<string, { viewState: boolean; alter: boolean }>();
    let queryStoreEverywhere = databases.length > 0;
    for (const database of databases) {
      const rows = await conn.query<{
        viewState: number | null;
        alter: number | null;
        queryStore: number | null;
      }>(
        `SELECT
           HAS_PERMS_BY_NAME(@db, 'DATABASE', 'VIEW DATABASE STATE') AS viewState,
           HAS_PERMS_BY_NAME(@db, 'DATABASE', 'ALTER') AS [alter],
           (SELECT TOP 1 CASE WHEN actual_state > 0 THEN 1 ELSE 0 END
              FROM ${quoteIdent(database)}.sys.database_query_store_options) AS queryStore`,
        { db: database },
      );
      const row = rows[0];
      perDb.set(database, { viewState: row?.viewState === 1, alter: row?.alter === 1 });
      if (row?.queryStore !== 1) queryStoreEverywhere = false;
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
      // Provisioning a scoped login is follow-up work — see the adapter's
      // capabilities.
      canProvision: false,
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
