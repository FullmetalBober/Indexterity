import type { Pool, PoolClient, QueryResultRow } from "pg";
import { workerEnv } from "../config/env";
import type { DialProxy, TlsOverrides } from "../engine/ports";
import { pgPool } from "./client";
import { parsePgConnString, pgHosts, withPgDatabase } from "./conn-string";
import { type PostgresServerVersion, parsePostgresVersion } from "./version";

// What the server said about itself at connect, read once per session.
export interface PostgresServerIdentity {
  // host:port from the string we dialled, NOT anything the server reports. There
  // is no `@@SERVERNAME` here: `inet_server_addr()` is NULL over a unix socket
  // and returns the address the server binds rather than the name we reached it
  // by, so the only stable per-member key is the one we used to get here (#202).
  readonly member: string;
  // `pg_postmaster_start_time()` as ISO. Load-bearing for `since`: a CLEAN
  // restart preserves cumulative statistics on pg 15+, but a crash discards
  // them AND sets `pg_stat_database.stats_reset` to NULL rather than to a new
  // timestamp — measured on 17.11. So a null stats_reset means either "never
  // reset" or "a crash wiped it", and this is the floor under both.
  readonly startedAt: string;
  // `pg_stat_database.stats_reset` for this database, or null. Null is ambiguous
  // on purpose — see above — and callers must fall back to startedAt.
  readonly statsReset: string | null;
  // `pg_is_in_recovery()`. A standby keeps its OWN idx_scan counters and refuses
  // every write, so this decides both whether usage read here is the whole
  // picture and whether the executor may run at all.
  readonly inRecovery: boolean;
  readonly version: PostgresServerVersion | null;
}

// Schemas that belong to the server rather than to anybody's application. Left
// as a list rather than a `nspname NOT LIKE 'pg_%'` test because that pattern
// would also hide a customer schema called `pg_archive`, and an index this
// pipeline cannot see is one it cannot protect either.
export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

// The database initdb creates so that a client has somewhere to connect before
// anything else exists. Named here because two things need it for opposite
// reasons: it is the usual target of a pasted connection string, and it is the
// one database this adapter reports only when it is not empty.
const DEFAULT_DATABASE = "postgres";

// Owns one pool PER DATABASE — the postgres twin of MssqlConnection, and the
// place the two engines genuinely diverge.
//
// SQL Server serves every database from one pool because every query is
// three-part qualified. PostgreSQL cannot: a connection is bound to one database
// for its life and `SELECT … FROM other.public.t` is a PARSE error rather than a
// permission one ("cross-database references are not implemented", verified on
// 17.11). So walking a cluster means one dial per database, opened lazily and
// held for the session's life — the same bargain members.ts makes for replicas,
// for the same reason: a three-database cluster costs three connections rather
// than three per collect.
/**
 * What the executor needs of a Postgres connection: four members.
 *
 * The twin of `MssqlWriter`, and separate from the class for the same reason —
 * a test hands over a complete object rather than claiming a literal IS a
 * connection. `execute` carries the build flag because the build budget is
 * asked for per statement (#410).
 */
export interface PostgresReader {
  query<T extends QueryResultRow>(
    text: string,
    params?: readonly unknown[],
    database?: string,
  ): Promise<T[]>;
  serverIdentity(): Promise<PostgresServerIdentity>;
  serverVersion(): Promise<PostgresServerVersion | null>;
}

export interface PostgresWriter extends PostgresReader {
  execute(text: string, database?: string, opts?: { build?: boolean }): Promise<void>;
}

// The one row `pg_stat_statements` answers with, and a port that names it.
//
// Split from the reader above because `query<T>` promises rows of whatever type
// the caller asks for: the only value assignable to `T[]` for every `T` is `[]`,
// so a test double for the workload read had to assert its statements into
// shape. Every field is `unknown` because that is what the driver hands back —
// `calls` and `rows` are bigint columns and arrive as STRINGS.
export type PgStatementRow = { query: unknown; calls: unknown; rows: unknown };

export interface PostgresStatementSource {
  query(text: string, params?: readonly unknown[], database?: string): Promise<PgStatementRow[]>;
}

export class PostgresConnection {
  private readonly pools = new Map<string, Pool>();
  private identity: PostgresServerIdentity | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly overrides?: TlsOverrides,
    private readonly proxy?: DialProxy,
  ) {}

  // The database the pasted string itself names, which is where cluster-wide
  // reads go: `pg_database`, `pg_stat_replication`, and the identity below are
  // all cluster-scoped catalogs readable from any database. Empty means libpq's
  // default (the role's own name), which is a real database we simply did not
  // name — so it is keyed under "" rather than guessed at.
  async connect(): Promise<void> {
    await this.poolFor("");
  }

  private async poolFor(database: string): Promise<Pool> {
    const existing = this.pools.get(database);
    if (existing !== undefined) return existing;
    // Only retarget when a database was actually asked for. Rewriting the string
    // to name the database it already names would turn a keyword-form string
    // into a different keyword-form string for no reason.
    const target =
      database === "" ? this.connectionString : withPgDatabase(this.connectionString, database);
    const pool = await pgPool(target, this.overrides, undefined, this.proxy);
    this.pools.set(database, pool);
    return pool;
  }

  // Run against one database. `database` empty means the connection's own.
  // `pool.query<T>` is generic itself, so the row type is carried by node-pg
  // rather than asserted back onto its result — which is what the `as T[]` here
  // used to do, at the one place raw rows enter the program.
  async query<T extends QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
    database = "",
  ): Promise<T[]> {
    const pool = await this.poolFor(database);
    const result = await pool.query<T>(text, [...params]);
    return result.rows;
  }

  // DDL that must NOT run inside a transaction: `CREATE INDEX CONCURRENTLY` and
  // `DROP INDEX CONCURRENTLY` both refuse with "cannot run inside a transaction
  // block" (verified on 17.11). A pooled `query` is already implicitly its own
  // transaction, which is fine — what this exists for is holding ONE connection
  // across a build so the session's statement_timeout and its `pg_stat_activity`
  // row belong to the statement a reader would go looking for.
  /**
   * Run one DDL statement.
   *
   * `build` raises the budget for this statement alone (#410). The pool-wide
   * `statement_timeout` is sized for a catalog read; a `CREATE INDEX
   * CONCURRENTLY` on a large table legitimately outruns it, and at 900s a build
   * that takes an hour could not finish at all.
   *
   * Set on the client that will run the statement and reset in the same
   * `finally` that releases it, because node-pg hands the connection to whoever
   * asks next and a session-level `SET` would otherwise leak a two-hour budget
   * onto every subsequent read through it. Three separate `query` calls rather
   * than one semicolon-joined string on purpose: the simple query protocol wraps
   * a multi-statement string in an implicit transaction, and `CREATE INDEX
   * CONCURRENTLY` cannot run inside one.
   */
  async execute(text: string, database = "", opts: { build?: boolean } = {}): Promise<void> {
    const pool = await this.poolFor(database);
    const client: PoolClient = await pool.connect();
    try {
      if (opts.build === true) {
        await client.query(`SET statement_timeout = ${workerEnv().INDEX_BUILD_TIMEOUT_MS}`);
      }
      await client.query(text);
    } finally {
      if (opts.build === true) {
        // Best effort: a client whose session is wedged is about to be discarded
        // by the pool anyway, and throwing here would mask the real failure.
        await client.query("RESET statement_timeout").catch(() => {});
      }
      client.release();
    }
  }

  // The server describing itself, cached: none of it can change under a live
  // connection except by a restart, which drops the connection too. Except
  // `inRecovery`, which changes on a promotion — and that also drops every
  // connection, so the cache is still safe.
  async serverIdentity(): Promise<PostgresServerIdentity> {
    if (this.identity !== null) return this.identity;
    const rows = await this.query<{
      version_num: unknown;
      version_text: unknown;
      started_at: unknown;
      stats_reset: unknown;
      in_recovery: unknown;
    }>(
      `SELECT current_setting('server_version_num')            AS version_num,
              current_setting('server_version')                AS version_text,
              to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"')            AS started_at,
              to_char((SELECT stats_reset FROM pg_stat_database
                        WHERE datname = current_database()) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"')            AS stats_reset,
              pg_is_in_recovery()                              AS in_recovery`,
    );
    const row = rows[0];
    this.identity = {
      member: this.member(),
      startedAt: typeof row?.started_at === "string" ? row.started_at : "",
      statsReset: typeof row?.stats_reset === "string" ? row.stats_reset : null,
      inRecovery: row?.in_recovery === true,
      version: parsePostgresVersion(row?.version_num, row?.version_text),
    };
    return this.identity;
  }

  async serverVersion(): Promise<PostgresServerVersion | null> {
    try {
      return (await this.serverIdentity()).version;
    } catch {
      // Unreadable version is treated as unsupported, never as "probably fine".
      return null;
    }
  }

  // The first host the string names, which is the one libpq tries first. A
  // multi-host HA string is narrowed to a single node before a member is read,
  // so this is only the fallback label for the cluster's own dial.
  private member(): string {
    const { hosts } = pgHosts(this.connectionString);
    return hosts[0] ?? "unknown";
  }

  // User databases only, the contract every adapter answers (engine/ports.ts).
  // Templates and anything with connections disabled are excluded because they
  // cannot be dialled at all.
  //
  // `postgres` is the awkward one, and it is excluded only WHILE IT IS EMPTY
  // (#347). It is not a system database — the server neither owns it nor uses it,
  // it exists because initdb creates one so there is somewhere to connect to —
  // but on almost every install it holds nothing, and reporting it made a
  // one-application cluster look like a two-database one. That is not cosmetic:
  // the observe checkboxes are drawn at two databases and up, so the same shape
  // that offers no choice on SQL Server offered a choice between an application
  // and an empty database here, and the default selection then dialled it and
  // read its statistics once per pass, forever.
  //
  // Excluding it by name outright was the alternative and it is worse: there is
  // no "show system databases" toggle, so an install that really does keep tables
  // in `postgres` would lose them with nothing on any screen to say why. The
  // probe is one catalog read on the database in question, against a pool this
  // session would otherwise have opened to walk it anyway.
  async listDatabaseNames(): Promise<string[]> {
    const names = (await this.catalogRows()).map((row) => row.datname);
    if (!names.includes(DEFAULT_DATABASE)) return names;
    if (await this.holdsUserTables(this.keyFor(DEFAULT_DATABASE))) return names;
    return names.filter((name) => name !== DEFAULT_DATABASE);
  }

  // Which pool to ask a database's own question through. "" when the string
  // already names it, because the pools are keyed by the name they were asked
  // for: `poolFor("postgres")` against a string that says `/postgres` would hold a
  // SECOND pool to the same database for the session's life, and naming `postgres`
  // is the most common shape a pasted string has.
  private keyFor(database: string): string {
    const parsed = parsePgConnString(this.connectionString);
    return parsed?.database === database ? "" : database;
  }

  // Is there anything of anybody's in there? Ordinary and partitioned tables
  // only, which is the same relkind pair the collector walks — a database whose
  // sole contents are views or sequences has no index for this product to have an
  // opinion about.
  //
  // Unreachable reads as empty rather than as an error: a database we cannot
  // enter cannot be walked either, so offering it would only produce a tick that
  // collects nothing.
  private async holdsUserTables(database: string): Promise<boolean> {
    try {
      return (await this.tableRows(database))[0]?.present === true;
    } catch {
      return false;
    }
  }

  // The two catalog reads, each naming the row it comes back with.
  //
  // Separate from `query<T>` because that method promises rows of whatever type
  // the caller asks for, and the only value assignable to `T[]` for every `T` is
  // `[]` — so a test double standing in for it has to assert its data into
  // shape. These say what the server answers, and a double just answers rows.
  protected async catalogRows(): Promise<{ datname: string }[]> {
    return this.query<{ datname: string }>(DATABASE_LISTING_SQL);
  }

  protected async tableRows(database: string): Promise<{ present: boolean }[]> {
    return this.query<{ present: boolean }>(USER_TABLES_SQL, [SYSTEM_SCHEMAS], database);
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    // All of them, even if one hangs: a leaked pool holds the customer's
    // connections open until their server times it out.
    await Promise.allSettled(pools.map((pool) => pool.end()));
  }
}

// Templates and undiallable databases are left to the statement's own filter:
// one cannot be dialled, so it never reaches the decision above.
export const DATABASE_LISTING_SQL = `SELECT datname FROM pg_database
        WHERE datallowconn AND NOT datistemplate
        ORDER BY datname`;

// Ordinary and partitioned tables only, the same relkind pair the collector
// walks: a database holding nothing but views has no index to have an opinion
// about.
export const USER_TABLES_SQL = `SELECT EXISTS (
           SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname <> ALL($1::text[])
         ) AS present`;
