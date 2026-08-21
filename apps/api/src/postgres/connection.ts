import type { Pool, PoolClient } from "pg";
import type { TlsOverrides } from "../engine/ports";
import { pgPool } from "./client";
import { pgHosts, withPgDatabase } from "./conn-string";
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
export class PostgresConnection {
  private readonly pools = new Map<string, Pool>();
  private identity: PostgresServerIdentity | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly overrides?: TlsOverrides,
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
    const pool = await pgPool(target, this.overrides);
    this.pools.set(database, pool);
    return pool;
  }

  // Run against one database. `database` empty means the connection's own.
  async query<T>(text: string, params: readonly unknown[] = [], database = ""): Promise<T[]> {
    const pool = await this.poolFor(database);
    const result = await pool.query(text, params as unknown[]);
    return result.rows as T[];
  }

  // DDL that must NOT run inside a transaction: `CREATE INDEX CONCURRENTLY` and
  // `DROP INDEX CONCURRENTLY` both refuse with "cannot run inside a transaction
  // block" (verified on 17.11). A pooled `query` is already implicitly its own
  // transaction, which is fine — what this exists for is holding ONE connection
  // across a build so the session's statement_timeout and its `pg_stat_activity`
  // row belong to the statement a reader would go looking for.
  async execute(text: string, database = ""): Promise<void> {
    const pool = await this.poolFor(database);
    const client: PoolClient = await pool.connect();
    try {
      await client.query(text);
    } finally {
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

  // User databases only. Templates and anything with connections disabled are
  // excluded because they cannot be dialled at all; `postgres` is KEPT, unlike
  // SQL Server's four system databases, because it is an ordinary database that
  // installs routinely put real tables in.
  async listDatabaseNames(): Promise<string[]> {
    const rows = await this.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datallowconn AND NOT datistemplate
        ORDER BY datname`,
    );
    return rows.map((row) => row.datname);
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
