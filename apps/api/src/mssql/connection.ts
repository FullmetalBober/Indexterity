import mssql from "mssql";
import { workerEnv } from "../config/env";
import type { TlsOverrides } from "../engine/ports";
import { type MssqlDialOptions, mssqlPool } from "./client";
import { type MssqlServerVersion, parseMssqlVersion } from "./version";

// A named parameter for query(). Values are always bound, never interpolated;
// identifiers (database, table, index names) cannot be bound in T-SQL and go
// through quoteIdent/quoteString instead.
export type QueryParams = Record<string, string | number>;

// ]]-escape an identifier for bracket quoting. The one rule that makes dynamic
// DDL safe: nothing inside [] terminates it except an unescaped ].
export function quoteIdent(name: string): string {
  return `[${name.replaceAll("]", "]]")}]`;
}

// ''-escape a string literal, for the few places a value must appear where
// parameters are not allowed (none today; kept beside quoteIdent so the next
// person finds the pair).
export function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// tedious hands bigint columns back as strings (SUMs over the DMVs' bigint
// counters, sizes in bytes), and a string ops count would turn classify's
// numeric comparisons lexicographic. Every numeric column read goes through
// here. Values fit in a double — the counters count operations and bytes, not
// nanoseconds since the epoch squared.
export function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" || typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// A collection name is "schema.table". Split on the FIRST dot: schema names
// with dots are not representable, table names with dots are. Documented on
// the wiki's Architecture page under Engine ports.
export function splitCollectionName(collection: string): { schema: string; table: string } {
  const dot = collection.indexOf(".");
  if (dot === -1) return { schema: "dbo", table: collection };
  return { schema: collection.slice(0, dot), table: collection.slice(dot + 1) };
}

// Fully quoted three-part name for a collection in a database.
export function qualifiedTable(database: string, collection: string): string {
  const { schema, table } = splitCollectionName(collection);
  return `${quoteIdent(database)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
}

// What the server said about itself at connect, read once per session.
export interface MssqlServerIdentity {
  // @@SERVERNAME — the per-member key in usage stats. One server, one member.
  readonly serverName: string;
  // sys.dm_os_sys_info.sqlserver_start_time as ISO — the honest `since` for
  // every usage counter: restart wipes them all (verified on 2022).
  readonly startedAt: string;
  // SERVERPROPERTY('EngineEdition'): 3 = Enterprise (and Developer), 5 = Azure
  // SQL Database, 8 = Managed Instance — the editions where ONLINE index
  // rebuild exists. Standard/Web/Express rebuild offline under a schema lock.
  readonly engineEdition: number;
  readonly version: MssqlServerVersion | null;
}

const ONLINE_REBUILD_EDITIONS = new Set([3, 5, 8]);

// One Availability Group replica as the catalog describes it.
export interface MssqlReplica {
  // replica_server_name — the instance's own @@SERVERNAME, which is also the
  // key usage rows are tagged with.
  readonly name: string;
  // read_only_routing_url ('tcp://host:port'), or null when the group has no
  // read-only routing configured for this replica.
  readonly routingUrl: string | null;
  // secondary_role_allow_connections: 0 NO, 1 READ_ONLY, 2 ALL.
  readonly secondaryAllows: number;
  readonly isLocal: boolean;
}

// Owns a driver pool — the mssql twin of MongoConnection. Every query is
// three-part qualified, so one pool serves every database the login can see.
// `new Request(parent, { requestTimeout })` — supported by mssql 12.7 at runtime
// (lib/base/request.js reads the second argument; lib/tedious/request.js applies
// it with `req.setTimeout`), and MISSING from @types/mssql 12.3, whose three
// constructor overloads all take one argument.
//
// Declared as a type and ASSIGNED rather than asserted, which is not a
// stylistic preference: a constructor taking fewer parameters is assignable to
// one taking more, so this needs no cast at all — and unlike `as`, it still
// checks that `mssql.Request` is constructible, that it accepts a
// ConnectionPool, and that it returns a Request. The only thing the compiler
// cannot know is whether the library READS the second argument, and that is
// what the test asserts by reading the override back off the request.
//
// When the types catch up this whole block deletes and the call site is
// unchanged.
type RequestWithOverrides = new (
  pool: mssql.ConnectionPool,
  overrides: { requestTimeout: number },
) => mssql.Request;

const RequestCtor: RequestWithOverrides = mssql.Request;

export function buildRequest(pool: mssql.ConnectionPool): mssql.Request {
  return new RequestCtor(pool, { requestTimeout: workerEnv().INDEX_BUILD_TIMEOUT_MS });
}

/**
 * What a reader needs of a connection: three answers out of twenty-two.
 *
 * Taking the whole `MssqlConnection` meant every test of this class had to claim
 * an object with these three on it WAS a connection — the other nineteen members
 * asserted away, unchecked, and silently wrong the moment one of them was
 * renamed. Naming the three makes each test's object a complete implementation.
 */
export interface MssqlSource {
  query<T>(text: string, params?: QueryParams): Promise<T[]>;
  serverIdentity(): Promise<MssqlServerIdentity>;
  localReplicaRole(): Promise<"primary" | "secondary" | null>;
}

/**
 * A member connection: read from it, and close it when the roster is done.
 *
 * `MssqlSource` plus the one thing the member manager owns. Separate from the
 * reader because a collector must not be able to close a connection it borrowed.
 */
/**
 * What the executor needs: read, write, and two questions about the server.
 *
 * Four of the connection's twenty-two, and deliberately NOT an extension of
 * `MssqlSource`: the executor never asks who the server is or which replica it
 * is on, and a port that demanded those would be describing a dependency this
 * class does not have. The distinction from the reader is real in the other
 * direction too — a collector must not be able to `execute` DDL against a
 * customer's database, and the type is where that is said.
 */
/**
 * What a read needs of a connection: one query, answering one row shape.
 *
 * `MssqlConnection` has 22 members and a collector uses one, so taking the whole
 * class meant a test had to fake 21 members it never called.
 *
 * Parameterised on the ROW rather than generic on the method, which is what
 * makes the double assertion-free. `query<T>()` promises "rows of whatever type
 * you ask for", and the only value assignable to `T[]` for every `T` is `[]` —
 * so any double with real data in it has to assert. Fixing the row at the port
 * says what this call actually returns, the real connection's generic `query`
 * satisfies it, and the double just answers rows.
 */
export interface MssqlReader<Row> {
  query(text: string): Promise<Row[]>;
}

export interface MssqlWriter<Row> {
  query(text: string, params?: QueryParams): Promise<Row[]>;
  execute(text: string, opts?: { build?: boolean }): Promise<void>;
  serverVersion(): Promise<MssqlServerVersion | null>;
  supportsOnlineRebuild(): Promise<boolean>;
}

export interface MssqlMemberSource extends MssqlSource {
  close(): Promise<void>;
}

export class MssqlConnection {
  private pool: mssql.ConnectionPool | null = null;
  private identity: MssqlServerIdentity | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly overrides?: TlsOverrides,
    private readonly dial?: MssqlDialOptions,
  ) {}

  async connect(): Promise<void> {
    // Throws InsecureConnectionError on a string that would not encrypt, or one
    // that disables a check nobody consented to — see mssql/client.ts.
    this.pool = await mssqlPool(this.connectionString, this.overrides, this.dial);
  }

  private livePool(): mssql.ConnectionPool {
    if (this.pool === null) throw new Error("MssqlConnection used before connect()");
    return this.pool;
  }

  async query<T>(text: string, params: QueryParams = {}): Promise<T[]> {
    const request = this.livePool().request();
    for (const [key, value] of Object.entries(params)) request.input(key, value);
    const result = await request.query<T>(text);
    return result.recordset ?? [];
  }

  /**
   * DDL statements (DISABLE/REBUILD/CREATE/DROP INDEX) — no recordset.
   *
   * `build` raises the budget for this statement alone (#410). The note that
   * used to be here said the driver has no per-request timeout, and that is not
   * true of mssql v12: `new Request(parent, { requestTimeout })` is honoured
   * (lib/base/request.js, applied in lib/tedious/request.js). So the pool-wide
   * budget no longer has to be sized for the slowest statement any adapter ever
   * makes — it can be sized for a DMV read, and a build can ask for what a build
   * needs.
   *
   * A fresh Request per statement either way, which is what the pool is for.
   */
  async execute(text: string, opts: { build?: boolean } = {}): Promise<void> {
    const request = opts.build === true ? buildRequest(this.livePool()) : this.livePool().request();
    await request.query(text);
  }

  // The server describing itself, cached: none of it can change under a live
  // connection except by a restart, which drops the connection too.
  async serverIdentity(): Promise<MssqlServerIdentity> {
    if (this.identity !== null) return this.identity;
    const rows = await this.query<{
      serverName: unknown;
      startedAt: unknown;
      engineEdition: unknown;
      productVersion: unknown;
    }>(
      `SELECT
         ISNULL(@@SERVERNAME, CONVERT(nvarchar(128), SERVERPROPERTY('MachineName'))) AS serverName,
         CONVERT(varchar(33), DATEADD(minute,
           DATEDIFF(minute, GETDATE(), GETUTCDATE()), si.sqlserver_start_time), 126) + 'Z'
           AS startedAt,
         CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engineEdition,
         CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS productVersion
       FROM sys.dm_os_sys_info si`,
    );
    const row = rows[0];
    const serverName = typeof row?.serverName === "string" ? row.serverName : "unknown";
    const startedAt =
      typeof row?.startedAt === "string" ? new Date(row.startedAt).toISOString() : "";
    const engineEdition = typeof row?.engineEdition === "number" ? row.engineEdition : 0;
    this.identity = {
      serverName,
      startedAt,
      engineEdition,
      version: parseMssqlVersion(row?.productVersion),
    };
    return this.identity;
  }

  async serverVersion(): Promise<MssqlServerVersion | null> {
    try {
      return (await this.serverIdentity()).version;
    } catch {
      // Unreadable version is treated as unsupported, never as "probably fine".
      return null;
    }
  }

  async supportsOnlineRebuild(): Promise<boolean> {
    return ONLINE_REBUILD_EDITIONS.has((await this.serverIdentity()).engineEdition);
  }

  // User databases only, the contract every adapter answers (engine/ports.ts):
  // the four the ENGINE owns, excluded by name.
  //
  // ONLINE only on top of that — an OFFLINE or RESTORING database cannot be
  // listed into at all. `model` and `msdb` are excluded even though a real
  // installation can be found with tables in them, unlike PostgreSQL's
  // `postgres`, and the difference is what each database IS: these four are
  // SQL Server's own working state, and putting application tables in one is an
  // anti-pattern Microsoft documents against rather than a shape to support.
  async listDatabaseNames(): Promise<string[]> {
    return listDatabaseNames(this);
  }

  // Every replica of every Availability Group this instance belongs to, as the
  // instance itself describes them (#202). Empty on a standalone: the views
  // exist on every edition and simply have no rows when HADR is off (verified
  // — `SERVERPROPERTY('IsHadrEnabled')` 0, both views readable, zero rows), so
  // discovery costs one cheap query and never needs a capability check.
  //
  // Deliberately NOT joined to sys.dm_hadr_availability_replica_states, though
  // that is where the roles live: on a SECONDARY that DMV holds only the local
  // replica's row — verified, one row against the catalog's two — so an inner
  // join would make a connection that landed on a secondary discover nothing at
  // all. Each replica reports its own role from its own connection instead,
  // which is the same rule mongo's roster follows.
  async availabilityReplicas(): Promise<MssqlReplica[]> {
    const rows = await this.query<{
      name: unknown;
      routingUrl: unknown;
      secondaryAllows: unknown;
      isLocal: unknown;
    }>(
      `SELECT
         ar.replica_server_name AS name,
         ar.read_only_routing_url AS routingUrl,
         ar.secondary_role_allow_connections AS secondaryAllows,
         CASE WHEN ar.replica_server_name = @@SERVERNAME THEN 1 ELSE 0 END AS isLocal
       FROM sys.availability_replicas ar
       ORDER BY ar.replica_server_name`,
    );
    return rows.flatMap((row) => {
      const name = typeof row.name === "string" ? row.name : null;
      if (name === null || name.length === 0) return [];
      return [
        {
          name,
          routingUrl: typeof row.routingUrl === "string" ? row.routingUrl : null,
          // 0 = NO, 1 = READ_ONLY (read-intent connections only), 2 = ALL —
          // verified against the _desc column on a live group.
          secondaryAllows: asNumber(row.secondaryAllows),
          isLocal: asNumber(row.isLocal) === 1,
        },
      ];
    });
  }

  // What this instance says IT is, right now: PRIMARY, SECONDARY, or nothing at
  // all when it belongs to no group. Read per connection rather than from the
  // primary's view of the group, so a roster never reports a role its owner
  // would dispute.
  async localReplicaRole(): Promise<"primary" | "secondary" | null> {
    const rows = await this.query<{ role: unknown }>(
      `SELECT role_desc AS role FROM sys.dm_hadr_availability_replica_states WHERE is_local = 1`,
    );
    const role = rows[0]?.role;
    if (role === "PRIMARY") return "primary";
    if (role === "SECONDARY") return "secondary";
    return null;
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1 AS ok");
  }

  async close(): Promise<void> {
    if (this.pool !== null) await this.pool.close();
    this.pool = null;
  }
}

// The listing statement, and the rule it carries.
//
// Excluded by name, which is the rule all three adapters follow (#347). `model`
// and `msdb` go even though a real installation can be found with tables in
// them — they are SQL Server's own working state. On top of the names: an
// OFFLINE or RESTORING database cannot be listed into, so `state = 0`.
export const DATABASE_LISTING_SQL = `SELECT name FROM sys.databases
       WHERE state = 0 AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
       ORDER BY name`;

// A free function over the reader rather than a method, so the statement and
// the mapping can be checked without standing up a connection at all.
export async function listDatabaseNames(reader: MssqlReader<{ name: string }>): Promise<string[]> {
  const rows = await reader.query(DATABASE_LISTING_SQL);
  return rows.map((row) => row.name);
}
