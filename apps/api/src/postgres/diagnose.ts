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
  readonly can_createdb: boolean;
  readonly can_grant_monitor: boolean;
  readonly in_pg_monitor: boolean;
  readonly pgss: boolean;
  readonly version_num: string | null;
  readonly version_text: string | null;
}

// One (database, schema) where this role can write rows it does not own (#313).
// Kept as pairs rather than a count because the REVOKE is per schema and cannot
// cross databases — a number would give the reader a finding and no statement.
export interface WritableSchema {
  readonly database: string;
  readonly schema: string;
  readonly tables: number;
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
    const writable = await writableSchemas(conn, inScope);
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
      surplus: surplusPrivileges(probe, writable),
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
      // Nothing was measured, so nothing can be claimed to be surplus. Empty
      // here means "we could not ask", which the card labels as an unreachable
      // cluster rather than as a clean bill of health.
      surplus: [],
      missing: [],
      databases: [],
    };
  } finally {
    await conn.close();
  }
}

// What this role holds that the engine never uses (#313).
//
// The role attributes are the easy half and were already half-probed for the
// PROVISION tier: CREATEROLE is a requirement to provision and a surplus grant
// to hold afterwards, which is not a contradiction — the first is a question
// about a string being pasted once, the second about one stored for a year.
//
// SUPERUSER is listed on its own even though it implies the other two, because
// `ALTER ROLE … NOSUPERUSER` is the only statement that removes it and NOCREATEDB
// on a superuser changes nothing at all. Both rows can be held at once and each
// carries the statement that actually applies to it.
//
// What is deliberately NOT here is SELECT on user tables. On this engine applying
// requires OWNERSHIP — no grantable index privilege exists — and an owner can
// always read the table, so a cluster in live mode holds read access as a
// consequence of a requirement rather than as surplus. Calling it surplus would
// tell a reader to revoke the thing that makes their APPLY row green. Writes are
// different: nothing in the pipeline inserts, updates or deletes a row, so a
// write grant on a table this role does not own is pure surplus, and that is the
// one this reports.
export function surplusPrivileges(
  probe: Pick<Probe, "whoami" | "is_super" | "can_createrole" | "can_createdb">,
  writable: readonly WritableSchema[],
): PrivilegeCheck[] {
  const me = quoteIdent(probe.whoami);
  const checks: PrivilegeCheck[] = [
    {
      key: "surplus_superuser",
      label: "SUPERUSER",
      enables:
        "everything on this server, including reading and rewriting every table — the engine uses none of it",
      tier: "SURPLUS",
      granted: probe.is_super,
      command: probe.is_super ? `ALTER ROLE ${me} NOSUPERUSER;` : null,
    },
    {
      key: "surplus_createrole",
      label: "CREATEROLE",
      enables:
        "creating and altering roles, which is how a role grants itself anything it does not have. Needed once to provision a scoped role; never needed by a stored connection",
      tier: "SURPLUS",
      granted: probe.can_createrole,
      command: probe.can_createrole ? `ALTER ROLE ${me} NOCREATEROLE;` : null,
    },
    {
      key: "surplus_createdb",
      label: "CREATEDB",
      enables: "creating and dropping databases — nothing in the analysis or the apply path does",
      tier: "SURPLUS",
      granted: probe.can_createdb,
      command: probe.can_createdb ? `ALTER ROLE ${me} NOCREATEDB;` : null,
    },
    {
      key: "surplus_write",
      label: "INSERT, UPDATE or DELETE on tables it does not own",
      enables:
        writable.length === 0
          ? "changing the rows in your tables. Nothing in the pipeline writes a row — it creates and drops indexes, which is an ownership question on this engine and a separate one"
          : `changing the rows in your tables — held on ${tableCount(writable)} across ` +
            `${schemaList(writable)}. Nothing in the pipeline writes a row. Each REVOKE below runs ` +
            "in its own database, because a privilege on a table cannot be revoked from outside it",
      tier: "SURPLUS",
      granted: writable.length > 0,
      command: writable.length === 0 ? null : revokeWrites(writable, me),
    },
  ];
  // Only what is actually HELD. A surplus list is a list of findings, so a row
  // saying "you do not have SUPERUSER" would be reassurance dressed as a finding
  // — and four of them would bury the one that is real. The empty case is said
  // once, by the screen, rather than four times here (#289).
  return checks.filter((check) => check.granted);
}

function tableCount(writable: readonly WritableSchema[]): string {
  const tables = writable.reduce((total, entry) => total + entry.tables, 0);
  return `${tables} ${tables === 1 ? "table" : "tables"}`;
}

function schemaList(writable: readonly WritableSchema[]): string {
  const names = writable.map((entry) => `${entry.database}.${entry.schema}`);
  // Bounded on purpose: a hundred-schema server would push the rest of the
  // sentence off the card, and the statements below name every one of them.
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

// One REVOKE per (database, schema), each under the psql `\\connect` that makes it
// runnable. ALL TABLES rather than a list of names: the grant was almost
// certainly made that way, and a script naming four hundred tables is not one
// anybody pastes.
//
// The default privileges line matters as much as the revoke and is the half
// people forget: `ALTER DEFAULT PRIVILEGES` is what stops the next table created
// in that schema from arriving with the same grant, so revoking without it fixes
// today and not tomorrow.
function revokeWrites(writable: readonly WritableSchema[], me: string): string {
  const byDatabase = new Map<string, WritableSchema[]>();
  for (const entry of writable) {
    const existing = byDatabase.get(entry.database);
    if (existing === undefined) byDatabase.set(entry.database, [entry]);
    else existing.push(entry);
  }
  const blocks: string[] = [];
  for (const [database, entries] of byDatabase) {
    // `\\connect` is a psql meta-command and not SQL, which is the honest answer
    // here: no SQL statement can cross a database boundary on this engine, so a
    // block that pretended otherwise would fail on the second database.
    const lines = [`\\connect ${quoteIdent(database)}`];
    for (const entry of entries) {
      const schema = quoteIdent(entry.schema);
      lines.push(`REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} FROM ${me};`);
      lines.push(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE INSERT, UPDATE, DELETE ON TABLES FROM ${me};`,
      );
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n");
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
            COALESCE((SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user), false)
              AS can_createdb,
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

// Where this role can write rows it does not own (#313), as (database, schema)
// pairs with a table count each.
//
// `NOT pg_has_role(… relowner …)` is the same ownership test `ownershipAcross`
// makes, negated: an owner's write access is a consequence of the ownership the
// APPLY tier requires, so counting it here would report a requirement as surplus.
// What is left is a grant somebody made on purpose, which is exactly what a
// REVOKE can take back.
//
// Grouped by schema because that is the granularity `REVOKE … ON ALL TABLES IN
// SCHEMA` works at, and per database because privileges cannot be revoked across
// one. Costs one round trip per database in scope, alongside the ownership count
// that already costs one.
async function writableSchemas(
  conn: PostgresConnection,
  databases: readonly string[],
): Promise<WritableSchema[]> {
  const found: WritableSchema[] = [];
  for (const database of databases) {
    try {
      const rows = await conn.query<{ nspname: string; tables: string | number }>(
        `SELECT n.nspname, count(*) AS tables
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')
            AND n.nspname NOT LIKE 'pg\\_%'
            AND n.nspname <> 'information_schema'
            AND NOT pg_has_role(current_user, c.relowner, 'USAGE')
            AND (has_table_privilege(c.oid, 'INSERT')
                 OR has_table_privilege(c.oid, 'UPDATE')
                 OR has_table_privilege(c.oid, 'DELETE'))
          GROUP BY n.nspname
          ORDER BY n.nspname`,
        [],
        database,
      );
      for (const row of rows) {
        found.push({ database, schema: row.nspname, tables: Number(row.tables) });
      }
    } catch {
      // A database this string cannot enter is already reported by the CONNECT
      // check, exactly as in `ownershipAcross` below — and a database we cannot
      // open is one we cannot claim holds a surplus grant either way.
    }
  }
  return found;
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
