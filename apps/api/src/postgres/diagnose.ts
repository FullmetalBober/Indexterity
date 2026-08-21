import type { ConnectionDiagnosis, PrivilegeCheck, TlsOverrides } from "../engine/ports";
import { pgConnStringUsername } from "./conn-string";
import { PostgresConnection } from "./connection";
import { quoteIdent } from "./executor";
import { postgresVersionRefusal } from "./version";

// What a connection string can actually do here, computed before anything is
// stored — so onboarding can say exactly what is missing instead of discovering
// it at the first collect.
//
// The APPLY tier is where PostgreSQL differs from both other engines and the
// difference is not a missing grant somebody can add. Only a table's OWNER may
// create or drop its indexes: `GRANT ALL PRIVILEGES` does not do it and neither
// does pg 17's `MAINTAIN` (both measured). So "can apply" here means "owns, or is
// a member of the role that owns, every table in scope" — and because an owner
// can always SELECT, a string that can apply can also read the data. That is
// said in the check's own `enables` text rather than left for somebody to work
// out, because it is the one place this product's usual promise does not hold.

interface Probe {
  readonly whoami: string;
  readonly is_super: boolean;
  readonly can_createrole: boolean;
  readonly can_grant_monitor: boolean;
  readonly in_pg_monitor: boolean;
  readonly pgss: boolean;
  readonly version_num: string | null;
  readonly version_text: string | null;
}

export async function diagnosePostgresConnection(
  connectionString: string,
  overrides?: TlsOverrides,
  observedDatabases?: readonly string[] | null,
): Promise<ConnectionDiagnosis> {
  const username = pgConnStringUsername(connectionString);
  const conn = new PostgresConnection(connectionString, overrides);
  try {
    await conn.connect();
    const probe = await readProbe(conn);
    const databases = await conn.listDatabaseNames();
    // Narrow what the answer is ABOUT, never what is reported as existing
    // (#244): the database list is what the observe checkboxes are drawn from,
    // so it stays whole whether or not a scope was given.
    const inScope =
      observedDatabases === undefined || observedDatabases === null
        ? databases
        : databases.filter((name) => observedDatabases.includes(name));

    const connectable = await connectableDatabases(conn, inScope);
    const ownership = await ownershipAcross(conn, inScope);
    const refusal = postgresVersionRefusal(
      parseVersion(probe),
      // The escape hatch is a deployment posture and not this function's
      // business; a preflight reports the ceiling as a gap rather than deciding
      // it away, and the adapter's own writes re-check it with the real flag.
      false,
    );

    const privileges: PrivilegeCheck[] = [
      {
        key: "connect",
        label: "CONNECT on every database in scope",
        enables:
          "reaching each database at all — a database it cannot connect to contributes nothing",
        tier: "CORE",
        granted: connectable.missing.length === 0,
        command:
          connectable.missing.length === 0
            ? null
            : connectable.missing
                .map(
                  (database) =>
                    `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(
                      probe.whoami,
                    )};`,
                )
                .join("\n"),
      },
      {
        key: "pg_monitor",
        label: "membership in pg_monitor",
        enables:
          "index usage, sizes, row counts and latency — every statistic the analysis needs, and none of the data in your tables",
        tier: "CORE",
        granted: probe.in_pg_monitor,
        command: probe.in_pg_monitor ? null : `GRANT pg_monitor TO ${quoteIdent(probe.whoami)};`,
      },
      {
        key: "pg_stat_statements",
        label: "the pg_stat_statements extension",
        enables:
          "query shapes, so missing indexes can be proposed and age-based purges spotted. Without it the drop side works as normal and there are simply no create-side recommendations",
        tier: "WORKLOAD",
        granted: probe.pgss,
        command: probe.pgss
          ? null
          : "-- add pg_stat_statements to shared_preload_libraries, restart, then:\nCREATE EXTENSION pg_stat_statements;",
      },
      {
        key: "table_owner",
        label: "ownership of the tables it manages",
        enables:
          "creating and dropping indexes. PostgreSQL has no grantable index privilege — only a table's owner may change its indexes, and an owner can also read the table. That is why analysis and applying are separate credentials here, unlike on MongoDB and SQL Server",
        tier: "APPLY",
        granted: ownership.owned > 0 && ownership.unowned === 0,
        command:
          ownership.unowned === 0
            ? null
            : `-- connect as the owner instead, or make this role a member of the owning role:\nGRANT <owning_role> TO ${quoteIdent(probe.whoami)};`,
      },
      {
        key: "createrole",
        label: "CREATEROLE",
        enables: "creating the read-only role Indexterity would rather run as",
        tier: "PROVISION",
        granted: probe.can_createrole || probe.is_super,
        command:
          probe.can_createrole || probe.is_super
            ? null
            : `ALTER ROLE ${quoteIdent(probe.whoami)} CREATEROLE;`,
      },
      {
        key: "grant_monitor",
        label: "the right to grant pg_monitor",
        enables: "giving that role its statistics access",
        tier: "PROVISION",
        granted: probe.can_grant_monitor || probe.is_super,
        command:
          probe.can_grant_monitor || probe.is_super
            ? null
            : `GRANT pg_monitor TO ${quoteIdent(probe.whoami)} WITH ADMIN OPTION;`,
      },
    ];

    const missing = privileges.filter((check) => !check.granted).map((check) => check.key);
    const core = privileges.filter((check) => check.tier === "CORE");
    const provision = privileges.filter((check) => check.tier === "PROVISION");
    return {
      reachable: true,
      message: refusal ?? advisory(privileges, ownership),
      username: username ?? probe.whoami,
      // Postgres always authenticates something — there is no anonymous
      // connection — so this is true whenever the dial succeeded at all.
      authEnabled: true,
      canProvision: provision.every((check) => check.granted),
      ready: refusal === null && core.every((check) => check.granted),
      canApply:
        refusal === null &&
        core.every((check) => check.granted) &&
        privileges.every((check) => check.tier !== "APPLY" || check.granted),
      privileges,
      missing,
      databases,
    };
  } catch (error) {
    return {
      reachable: false,
      message: (error as Error).message,
      username,
      authEnabled: true,
      canProvision: false,
      ready: false,
      canApply: false,
      privileges: [],
      missing: [],
      databases: [],
    };
  } finally {
    await conn.close();
  }
}

// The one advisory worth making on an otherwise usable connection: this string
// analyses fine and cannot apply, which on this engine is the NORMAL state for a
// least-privilege role rather than a misconfiguration to fix.
function advisory(
  privileges: readonly PrivilegeCheck[],
  ownership: { owned: number; unowned: number },
): string | null {
  const apply = privileges.find((check) => check.tier === "APPLY");
  if (apply === undefined || apply.granted) return null;
  if (ownership.owned === 0) {
    return (
      "These credentials can analyse every table in scope and change none of them, " +
      "which is the intended shape for a read-only PostgreSQL cluster: only a " +
      "table's owner may alter its indexes, and an owner can also read it. Connect " +
      "as the owner when you want to apply."
    );
  }
  return (
    `These credentials own some of the tables in scope but not all of them ` +
    `(${ownership.unowned} of ${ownership.owned + ownership.unowned} are owned by ` +
    "somebody else), so recommendations for the rest can be made and not applied."
  );
}

async function readProbe(conn: PostgresConnection): Promise<Probe> {
  const rows = await conn.query<Probe>(
    `SELECT current_user::text AS whoami,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
              AS is_super,
            COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user), false)
              AS can_createrole,
            EXISTS(
              SELECT 1 FROM pg_auth_members m
                JOIN pg_roles granted ON granted.oid = m.roleid
                JOIN pg_roles grantee ON grantee.oid = m.member
               WHERE granted.rolname = 'pg_monitor'
                 AND grantee.rolname = current_user
                 AND m.admin_option
            ) AS can_grant_monitor,
            pg_has_role(current_user, 'pg_monitor', 'USAGE') AS in_pg_monitor,
            EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS pgss,
            current_setting('server_version_num') AS version_num,
            current_setting('server_version')     AS version_text`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("the server answered nothing about itself");
  return row;
}

// Decoded here rather than through parsePostgresVersion because the probe
// already read both settings in its single round trip, and re-deriving them from
// a fresh identity read would ask the server the same question twice.
function parseVersion(probe: Probe) {
  const major = Math.floor(Number(probe.version_num) / 10000);
  const minor = Number(probe.version_num) % 10000;
  if (!Number.isInteger(major) || major === 0) return null;
  return { major, minor, text: probe.version_text ?? String(probe.version_num) };
}

// Which of the databases in scope this string can actually open. Asked per
// database rather than inferred from `pg_database`, because CONNECT is a
// per-database privilege and a role can see a database it cannot enter.
async function connectableDatabases(
  conn: PostgresConnection,
  databases: readonly string[],
): Promise<{ ok: string[]; missing: string[] }> {
  if (databases.length === 0) return { ok: [], missing: [] };
  const rows = await conn.query<{ datname: string; allowed: boolean }>(
    `SELECT datname, has_database_privilege(datname, 'CONNECT') AS allowed
       FROM pg_database WHERE datname = ANY($1::text[])`,
    [databases],
  );
  const ok = rows.filter((row) => row.allowed).map((row) => row.datname);
  const missing = rows.filter((row) => !row.allowed).map((row) => row.datname);
  return { ok, missing };
}

// How many tables in scope this role owns, and how many it does not.
//
// `pg_has_role(current_user, relowner, 'USAGE')` rather than a name comparison,
// so membership in the owning role counts — which is the only way a role other
// than the owner can ever alter an index here.
async function ownershipAcross(
  conn: PostgresConnection,
  databases: readonly string[],
): Promise<{ owned: number; unowned: number }> {
  let owned = 0;
  let unowned = 0;
  for (const database of databases) {
    try {
      const rows = await conn.query<{ owned: string | number; unowned: string | number }>(
        `SELECT count(*) FILTER (WHERE pg_has_role(current_user, c.relowner, 'USAGE')) AS owned,
                count(*) FILTER (WHERE NOT pg_has_role(current_user, c.relowner, 'USAGE'))
                  AS unowned
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')
            AND n.nspname NOT LIKE 'pg\\_%'
            AND n.nspname <> 'information_schema'`,
        [],
        database,
      );
      owned += Number(rows[0]?.owned ?? 0);
      unowned += Number(rows[0]?.unowned ?? 0);
    } catch {
      // A database this string cannot enter is already reported by the CONNECT
      // check; counting it as unowned as well would name one problem twice.
    }
  }
  return { owned, unowned };
}
