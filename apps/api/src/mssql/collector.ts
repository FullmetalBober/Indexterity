import type { IndexKey, IndexSpec, QueryShape, ServerHealth } from "../analysis";
import type {
  ClusterNode,
  CollectionLatency,
  CollectionStorage,
  DeletePattern,
  IndexCollector,
  IndexUsageStat,
  LatencyPair,
  WorkloadTarget,
} from "../engine/ports";
import {
  asNumber,
  MssqlConnection,
  qualifiedTable,
  quoteIdent,
  splitCollectionName,
} from "./connection";
import type { MssqlMemberConnections } from "./members";
import { type PlanRow, shapesFromPlans } from "./workload";

// Plans read per database and collect. Query Store defaults to a 1GB store —
// a few thousand plans — so the cap is headroom, not a working truncation;
// when it does bind, the ORDER BY keeps the most recently executed plans and
// drops the stalest, which is the end the recurrence gates ignore anyway.
const MAX_PLANS_PER_DATABASE = 5000;

// The SQL Server implementation of the collector port, over the surfaces the
// probe validated (issue #36):
//
//   sys.dm_db_index_usage_stats   per-index reads/writes. Server-wide with a
//                                 database_id column; wiped by a restart AND
//                                 zeroed by ALTER INDEX REBUILD (verified on
//                                 2022 CU24) — which is why `since` is the
//                                 server start time and analysis/classify.ts
//                                 additionally distrusts any counter that went
//                                 backwards.
//   sys.dm_db_partition_stats     sizes. A disabled index owns no pages and
//                                 honestly reports 0.
//   Query Store                   the workload/latency source: the only one
//                                 that survives a restart (verified). Read/write
//                                 latency per table is attributed by matching
//                                 the plan XML's Object element, whose
//                                 attributes are adjacent in a stable order
//                                 (Database, Schema, Table — verified).
//
// Everything is three-part qualified ([db].sys.…), which retargets catalog
// views, database-scoped DMVs and Query Store views alike (verified from the
// master context), so one connection serves every database the login can see.
//
// Create-side signals (query shapes, missing-index DMVs, delete patterns) are
// deliberately empty in v1 — the drop side is the product here, and the
// missing-index DMVs need the recurrence and cost gates #36 describes before
// they are safe to repeat to anyone.

// LIKE-escape inside a pattern: [ opens a character class, % and _ are wild.
function likeEscape(value: string): string {
  return value.replace(/[[%_]/g, (match) => `[${match}]`);
}

// The pattern that finds every Query Store plan touching a table. Bracketed
// exactly as showplan XML writes it: Schema="[dbo]" Table="[orders]".
function tablePlanPattern(collection: string): string {
  const { schema, table } = splitCollectionName(collection);
  return `%Schema="${likeEscape(`[${schema}]`)}" Table="${likeEscape(`[${table}]`)}"%`;
}

interface IndexRow {
  readonly indexName: string;
  readonly indexType: number;
  readonly isUnique: boolean;
  readonly isPrimaryKey: boolean;
  readonly isUniqueConstraint: boolean;
  readonly isDisabled: boolean;
  readonly hasFilter: boolean;
  readonly filterDefinition: string | null;
  readonly keyOrdinal: number;
  readonly isDescending: boolean;
  readonly columnName: string;
  // sys.index_columns lists an INCLUDEd column as key_ordinal 0 with
  // is_included_column 1. Both are read: the ordinal alone would also match
  // rows a future SQL Server could add for something else.
  readonly isIncluded: boolean;
  // Position within the index — keys first in key order, then the includes in
  // the order they were declared. Verified on 2022: an index created as
  // INCLUDE (total, email) reports total before email even though email has
  // the lower column_id, so this is the declared order and not a catalog
  // artefact.
  readonly indexColumnId: number;
}

// Rowstore only: 1 = clustered, 2 = nonclustered. Columnstore, XML, spatial and
// full-text indexes serve queries b-tree reasoning does not describe, so they
// are invisible to the pipeline rather than mis-modelled by it.
const ROWSTORE_TYPES = "(1, 2)";

export function toMssqlIndexSpec(rows: readonly IndexRow[]): IndexSpec | null {
  const first = rows[0];
  if (first === undefined) return null;
  const keys: IndexKey[] = rows
    .filter((row) => !row.isIncluded)
    .sort((a, b) => a.keyOrdinal - b.keyOrdinal)
    .map((row) => ({ field: row.columnName, direction: row.isDescending ? -1 : 1 }));
  // An index whose every row is an include cannot happen — INCLUDE requires a
  // key — so this is a malformed read rather than a keyless index, and the
  // pipeline is better off not seeing it than seeing it as keyless.
  if (keys.length === 0) return null;
  const include = rows
    .filter((row) => row.isIncluded)
    .sort((a, b) => a.indexColumnId - b.indexColumnId)
    .map((row) => row.columnName);
  return {
    name: first.indexName,
    keys,
    // is_unique is set on PK and unique-constraint indexes too; the or-chain is
    // belt and braces because `unique` is what isNeverDrop keys on, and every
    // one of these classes suspends its constraint while disabled (verified —
    // a duplicate insert succeeded under a disabled unique index).
    unique: first.isUnique || first.isPrimaryKey || first.isUniqueConstraint,
    ttl: false,
    partial: first.hasFilter,
    // The filter is a T-SQL predicate, not a mongo expression; carried under a
    // `definition` key so a REORDER or an undo can rebuild it verbatim.
    partialFilter: first.filterDefinition === null ? null : { definition: first.filterDefinition },
    sparse: false,
    // A disabled index is the hidden state: invisible to the planner, not
    // maintained, definition retained. Same lifecycle slot as collMod hidden.
    hidden: first.isDisabled,
    // The clustered index IS the table — dropping it is a rebuild of the whole
    // table's storage, and disabling it takes the table offline (verified,
    // Msg 8655). isShardKey is the port's "the cluster does not work without
    // it" flag, and this is exactly that.
    isShardKey: first.indexType === 1,
    collation: null,
    // Omitted rather than empty when there are none: "carries nothing extra"
    // and "this engine has no includes" are the same statement to every reader,
    // and this keeps a persisted spec byte-identical to what it was before
    // includes were captured for the indexes that have none.
    ...(include.length === 0 ? {} : { include }),
  };
}

// Index names extracted from `WITH (INDEX(…))` hints in statement text, and
// from Index="[…]" attributes in forced plans. Over-reporting is the safe
// direction — a name that is not an index on this table is ignored by the
// snapshot layer, and a hinted index that goes unreported would be hidden and
// break its queries with Msg 315 (verified).
export function indexNamesFromHintText(text: string): string[] {
  const names: string[] = [];
  const hint = /\bINDEX\s*[(=]\s*(\[[^\]]+\]|[A-Za-z0-9_#$@]+)/gi;
  for (const match of text.matchAll(hint)) {
    const raw = match[1] ?? "";
    const name = raw.startsWith("[") ? raw.slice(1, -1) : raw;
    // Positional hints (INDEX(1)) name the clustered index by ordinal; the
    // pipeline never hides a clustered index, so they are safely dropped here.
    if (name.length > 0 && !/^\d+$/.test(name)) names.push(name);
  }
  return names;
}

export function indexNamesFromForcedPlan(planXml: string): string[] {
  const names: string[] = [];
  for (const match of planXml.matchAll(/Index="\[((?:[^\]]|\]\])+)\]"/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name.replaceAll("]]", "]"));
  }
  return names;
}

export class MssqlIndexCollector implements IndexCollector {
  constructor(
    private readonly conn: MssqlConnection,
    // Absent for a plain connection (diagnose, tests). Present from the
    // session, where an Availability Group's readable secondaries are dialled
    // as members — see mssql/members.ts.
    private readonly members?: MssqlMemberConnections,
  ) {}

  async listCollectionNames(database: string): Promise<string[]> {
    const rows = await this.conn.query<{ name: string }>(
      `SELECT s.name + '.' + t.name AS name
       FROM ${quoteIdent(database)}.sys.tables t
       JOIN ${quoteIdent(database)}.sys.schemas s ON s.schema_id = t.schema_id
       WHERE t.is_ms_shipped = 0
       ORDER BY s.name, t.name`,
    );
    return rows.map((row) => row.name);
  }

  // Key columns AND included columns, in one read: this used to filter
  // `key_ordinal > 0`, which reported a covering index as its bare key list and
  // let the redundancy rule offer it up as a prefix of a wider-keyed index that
  // covers nothing it covered. The split now happens in toMssqlIndexSpec, where
  // both halves are visible.
  async listIndexes(database: string, collection: string): Promise<IndexSpec[]> {
    const rows = await this.conn.query<IndexRow>(
      `SELECT
         i.name AS indexName,
         i.type AS indexType,
         i.is_unique AS isUnique,
         i.is_primary_key AS isPrimaryKey,
         i.is_unique_constraint AS isUniqueConstraint,
         i.is_disabled AS isDisabled,
         i.has_filter AS hasFilter,
         i.filter_definition AS filterDefinition,
         ic.key_ordinal AS keyOrdinal,
         ic.is_descending_key AS isDescending,
         ic.is_included_column AS isIncluded,
         ic.index_column_id AS indexColumnId,
         c.name AS columnName
       FROM ${quoteIdent(database)}.sys.indexes i
       JOIN ${quoteIdent(database)}.sys.index_columns ic
         ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN ${quoteIdent(database)}.sys.columns c
         ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(@qualified)
         AND i.type IN ${ROWSTORE_TYPES}
         AND i.is_hypothetical = 0
         AND i.name IS NOT NULL
       ORDER BY i.index_id, ic.index_column_id`,
      { qualified: qualifiedTable(database, collection) },
    );
    const grouped = new Map<string, IndexRow[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.indexName) ?? [];
      bucket.push(row);
      grouped.set(row.indexName, bucket);
    }
    const specs: IndexSpec[] = [];
    for (const bucket of grouped.values()) {
      const spec = toMssqlIndexSpec(bucket);
      if (spec !== null) specs.push(spec);
    }
    return specs;
  }

  // The roster (#202): the instance the connection string reaches, plus every
  // other replica of its Availability Group and how each dial went. A
  // standalone names no replicas and reports itself alone, exactly as before —
  // and when even that much cannot be established, null, never a guess.
  async collectNodes(): Promise<readonly ClusterNode[] | null> {
    let local: ClusterNode;
    try {
      const identity = await this.conn.serverIdentity();
      // Its own role, not the group's view of it. A standalone belongs to no
      // group and is honestly a standalone.
      const role = await this.conn.localReplicaRole().catch(() => null);
      local = { host: identity.serverName, role: role ?? "standalone", state: "answered" };
    } catch {
      return null;
    }
    const dials = this.members === undefined ? [] : await this.members.dials();
    const others = await Promise.all(
      dials.map(async (dial): Promise<ClusterNode> => {
        if (dial.connection === null) {
          return { host: dial.host, role: "unknown", state: dial.state };
        }
        const role = await dial.connection.localReplicaRole().catch(() => null);
        return { host: dial.host, role: role ?? "unknown", state: "answered" };
      }),
    );
    return [local, ...others];
  }

  async collectUsage(database: string, collection: string): Promise<IndexUsageStat[]> {
    // Every replica, not only the one the connection string reaches: the usage
    // DMV counts what THIS instance served, so a readable secondary's reads are
    // invisible from the primary (mssql/members.ts has the measurement).
    const connections = [this.conn, ...(await (this.members?.all() ?? Promise.resolve([])))];
    const perMember = await Promise.all(
      connections.map((conn) =>
        // One replica failing mid-collect must not lose the others' readings:
        // a member that answered the dial and then went away contributes
        // nothing, which is what an unreachable member has always meant here.
        this.usageFrom(conn, database, collection).catch(() => [] as IndexUsageStat[]),
      ),
    );
    // Keyed by index AND host, NUL-separated because an index name and a server
    // name may both contain almost anything: the same index reports once per
    // replica, and each replica's counter has its own `since`.
    const seen = new Map<string, IndexUsageStat>();
    for (const stat of perMember.flat()) seen.set(`${stat.indexName}\u0000${stat.host}`, stat);
    return [...seen.values()];
  }

  private async usageFrom(
    conn: MssqlConnection,
    database: string,
    collection: string,
  ): Promise<IndexUsageStat[]> {
    const identity = await conn.serverIdentity();
    const rows = await conn.query<{ indexName: string; ops: number }>(
      // LEFT JOIN: an index with no row has served nothing since the counters
      // started, and that absence is a reading of zero, not a gap. The usage
      // DMV is server-wide with a database_id column — no retargeting needed.
      `SELECT
         i.name AS indexName,
         COALESCE(s.user_seeks, 0) + COALESCE(s.user_scans, 0) + COALESCE(s.user_lookups, 0) AS ops
       FROM ${quoteIdent(database)}.sys.indexes i
       LEFT JOIN sys.dm_db_index_usage_stats s
         ON s.database_id = DB_ID(@db) AND s.object_id = i.object_id AND s.index_id = i.index_id
       WHERE i.object_id = OBJECT_ID(@qualified)
         AND i.type IN ${ROWSTORE_TYPES}
         AND i.is_hypothetical = 0
         AND i.name IS NOT NULL`,
      { db: database, qualified: qualifiedTable(database, collection) },
    );
    return rows.map((row) => ({
      indexName: row.indexName,
      host: identity.serverName,
      // bigint columns arrive as strings — see asNumber.
      ops: asNumber(row.ops),
      // When the counters started: the service start. A REBUILD also restarts
      // one index's counter WITHOUT moving this (verified on 2022) — that case
      // is caught engine-neutrally by the ops-went-backwards rule in
      // analysis/classify.ts.
      since: identity.startedAt,
    }));
  }

  async collectionStorage(database: string, collection: string): Promise<CollectionStorage> {
    const rows = await this.conn.query<{ dataSizeBytes: number; docCount: number }>(
      // Index ids 0 and 1 are the heap or the clustered index — the table
      // itself. Partitions sum; row_count is per partition of the data.
      `SELECT
         COALESCE(SUM(p.used_page_count), 0) * 8192 AS dataSizeBytes,
         COALESCE(SUM(p.row_count), 0) AS docCount
       FROM ${quoteIdent(database)}.sys.dm_db_partition_stats p
       WHERE p.object_id = OBJECT_ID(@qualified) AND p.index_id IN (0, 1)`,
      { qualified: qualifiedTable(database, collection) },
    );
    const row = rows[0];
    return { dataSizeBytes: asNumber(row?.dataSizeBytes), docCount: asNumber(row?.docCount) };
  }

  async indexSizes(database: string, collection: string): Promise<Record<string, number>> {
    const rows = await this.conn.query<{ indexName: string; sizeBytes: number }>(
      `SELECT i.name AS indexName, COALESCE(SUM(p.used_page_count), 0) * 8192 AS sizeBytes
       FROM ${quoteIdent(database)}.sys.indexes i
       LEFT JOIN ${quoteIdent(database)}.sys.dm_db_partition_stats p
         ON p.object_id = i.object_id AND p.index_id = i.index_id
       WHERE i.object_id = OBJECT_ID(@qualified)
         AND i.type IN ${ROWSTORE_TYPES}
         AND i.is_hypothetical = 0
         AND i.name IS NOT NULL
       GROUP BY i.name`,
      { qualified: qualifiedTable(database, collection) },
    );
    const totals: Record<string, number> = {};
    for (const row of rows) totals[row.indexName] = asNumber(row.sizeBytes);
    return totals;
  }

  // Read/write ops and latency per table, from Query Store: executions and
  // average duration (microseconds) summed over every plan whose XML touches
  // the table, split read/write on the statement type. Cumulative in spirit —
  // Query Store accumulates across restarts (verified) — with two honest
  // caveats the gates already tolerate: size-based cleanup can retire old
  // intervals (a counter that shrinks reads as UNOBSERVABLE, never as a
  // verdict), and a hard crash loses the last unflushed interval (default
  // 15 minutes).
  async collectionLatency(database: string, collection: string): Promise<CollectionLatency> {
    const enabled = await this.queryStoreEnabled(database);
    if (!enabled) {
      return {
        reads: { ops: 0, latencyMicros: 0 },
        writes: { ops: 0, latencyMicros: 0 },
      };
    }
    const rows = await this.conn.query<{
      readOps: number;
      readMicros: number;
      writeOps: number;
      writeMicros: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN plans.xml LIKE '%StatementType="SELECT"%'
           THEN rs.count_executions ELSE 0 END), 0) AS readOps,
         COALESCE(SUM(CASE WHEN plans.xml LIKE '%StatementType="SELECT"%'
           THEN rs.count_executions * rs.avg_duration ELSE 0 END), 0) AS readMicros,
         COALESCE(SUM(CASE WHEN plans.xml LIKE '%StatementType="SELECT"%'
           THEN 0 ELSE rs.count_executions END), 0) AS writeOps,
         COALESCE(SUM(CASE WHEN plans.xml LIKE '%StatementType="SELECT"%'
           THEN 0 ELSE rs.count_executions * rs.avg_duration END), 0) AS writeMicros
       FROM (
         SELECT p.plan_id, CAST(p.query_plan AS nvarchar(max)) AS xml
         FROM ${quoteIdent(database)}.sys.query_store_plan p
       ) plans
       JOIN ${quoteIdent(database)}.sys.query_store_runtime_stats rs
         ON rs.plan_id = plans.plan_id
       WHERE plans.xml LIKE @pattern`,
      { pattern: tablePlanPattern(collection) },
    );
    const row = rows[0];
    return {
      reads: {
        ops: asNumber(row?.readOps),
        latencyMicros: Math.round(asNumber(row?.readMicros)),
      },
      writes: {
        ops: asNumber(row?.writeOps),
        latencyMicros: Math.round(asNumber(row?.writeMicros)),
      },
    };
  }

  async readLatency(database: string, collection: string): Promise<LatencyPair> {
    const { reads } = await this.collectionLatency(database, collection);
    return reads;
  }

  // Indexes named explicitly in the workload: `WITH (INDEX(…))` hints in Query
  // Store statement texts, plus every index a FORCED plan pins (freezing a plan
  // is the moral equivalent of a hint, and disabling an index a forced plan
  // uses breaks the force). Msg 315 is what hiding a hinted index does to its
  // queries (verified) — the same break-not-slow trap as mongo hint().
  async collectHintedIndexes(database: string, collection: string): Promise<string[]> {
    if (!(await this.queryStoreEnabled(database))) return [];
    const names = new Set<string>();
    const hinted = await this.conn.query<{ text: string }>(
      `SELECT DISTINCT qt.query_sql_text AS text
       FROM ${quoteIdent(database)}.sys.query_store_query_text qt
       WHERE qt.query_sql_text LIKE @tableLike AND qt.query_sql_text LIKE '%INDEX%'`,
      { tableLike: `%${likeEscape(splitCollectionName(collection).table)}%` },
    );
    for (const row of hinted) {
      for (const name of indexNamesFromHintText(row.text)) names.add(name);
    }
    const forced = await this.conn.query<{ xml: string }>(
      `SELECT CAST(p.query_plan AS nvarchar(max)) AS xml
       FROM ${quoteIdent(database)}.sys.query_store_plan p
       WHERE p.is_forced_plan = 1
         AND CAST(p.query_plan AS nvarchar(max)) LIKE @pattern`,
      { pattern: tablePlanPattern(collection) },
    );
    for (const row of forced) {
      for (const name of indexNamesFromForcedPlan(row.xml)) names.add(name);
    }
    return [...names];
  }

  // Query Store is the ONE workload store — there is no second source to fall
  // back to (mongo's profiler has no twin here), so the slow-query fallback
  // stays empty and everything create-side flows through collectWorkload.
  collectSlowQueries(_database: string, _collection: string): Promise<QueryShape[]> {
    return Promise.resolve([]);
  }

  // Query shapes per namespace, from Query Store plans (#201): one pass per
  // database, every plan's XML parsed once and bucketed to the targets it
  // touches — see mssql/workload.ts for the anatomy. Capped at the most
  // recently executed plans; a store larger than the cap contributes its
  // busiest recent shapes rather than everything, which is what the
  // recurrence gates read anyway.
  async collectWorkload(
    targets: readonly WorkloadTarget[],
  ): Promise<Map<string, readonly QueryShape[]>> {
    const result = new Map<string, readonly QueryShape[]>();
    const byDatabase = new Map<string, WorkloadTarget[]>();
    for (const target of targets) {
      const bucket = byDatabase.get(target.database) ?? [];
      bucket.push(target);
      byDatabase.set(target.database, bucket);
    }
    const now = new Date();
    for (const [database, databaseTargets] of byDatabase) {
      if (!(await this.queryStoreEnabled(database))) continue;
      const rows = await this.conn.query<{
        planXml: string;
        execs: unknown;
        totalIo: unknown;
        firstSeen: Date | string | null;
        lastSeen: Date | string | null;
      }>(
        // is_internal_query = 0 keeps the server's own work out of the
        // workload: an index build is recorded as an internal
        // "insert … select * from …" plan — StatementType INSERT, full scan
        // plus a sort — which would otherwise hand the suggest engine a
        // phantom missing-index shape every time an index is BUILT, ours
        // included (observed live on 2022).
        `SELECT TOP ${MAX_PLANS_PER_DATABASE}
           CAST(p.query_plan AS nvarchar(max)) AS planXml,
           agg.execs, agg.totalIo, agg.firstSeen, agg.lastSeen
         FROM (
           SELECT plan_id,
             SUM(count_executions) AS execs,
             SUM(count_executions * avg_logical_io_reads) AS totalIo,
             MIN(first_execution_time) AS firstSeen,
             MAX(last_execution_time) AS lastSeen
           FROM ${quoteIdent(database)}.sys.query_store_runtime_stats
           GROUP BY plan_id
         ) agg
         JOIN ${quoteIdent(database)}.sys.query_store_plan p ON p.plan_id = agg.plan_id
         JOIN ${quoteIdent(database)}.sys.query_store_query q ON q.query_id = p.query_id
         WHERE q.is_internal_query = 0
         ORDER BY agg.lastSeen DESC`,
      );
      const planRows: PlanRow[] = rows.map((row) => ({
        planXml: row.planXml,
        execs: asNumber(row.execs),
        totalIo: asNumber(row.totalIo),
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
      }));
      for (const [key, shapes] of shapesFromPlans(databaseTargets, database, planRows, now)) {
        result.set(key, shapes);
      }
    }
    return result;
  }

  collectDeletePatterns(_database: string, _collection: string): Promise<DeletePattern[]> {
    return Promise.resolve([]);
  }

  // No mapping yet: the mongo counters this feeds (collection scans per
  // interval, docs-per-key) have no per-server twins cheap enough to trust.
  // Null is the port's "could not read", and everything else works without it.
  collectServerHealth(): Promise<ServerHealth | null> {
    return Promise.resolve(null);
  }

  private readonly queryStoreState = new Map<string, boolean>();

  private async queryStoreEnabled(database: string): Promise<boolean> {
    const cached = this.queryStoreState.get(database);
    if (cached !== undefined) return cached;
    let enabled = false;
    try {
      const rows = await this.conn.query<{ state: number }>(
        // 1 = READ_ONLY (history still readable), 2 = READ_WRITE.
        `SELECT actual_state AS state
         FROM ${quoteIdent(database)}.sys.database_query_store_options`,
      );
      enabled = rows[0] !== undefined && rows[0].state > 0;
    } catch {
      enabled = false;
    }
    this.queryStoreState.set(database, enabled);
    return enabled;
  }
}
