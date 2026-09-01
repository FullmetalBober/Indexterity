import type { QueryResultRow } from "pg";
import {
  type ClusterNode,
  DatabaseInaccessibleError,
  type DeletePattern,
  type IndexCollector,
  type IndexUsageStat,
  type LatencyPair,
  type WorkloadTarget,
  workloadKey,
} from "../engine/ports";
import type { IndexKey, IndexSpec, QueryShape, ServerHealth } from "../engine/types";
import { field } from "../errors/message";
import { type PostgresReader, type PostgresStatementSource, SYSTEM_SCHEMAS } from "./connection";
import { collectPostgresHealth } from "./health";
import { collectPostgresNodes } from "./members";
import { postgresHasLastIdxScan } from "./version";
import { deletePatternOf, type NormalizedStatement, shapeOf } from "./workload";

// The read side of the PostgreSQL collector. Everything here is a catalog or a
// statistics view — nothing in this file can read a stored value, which is the
// property the scoped role is built to guarantee (see provision.ts).
//
// VOCABULARY. The ports are MongoDB-flavoured by decision (engine/ports.ts), so
// a relational adapter maps rather than renaming the codebase: `database` is a
// PostgreSQL database, and `collection` is a **schema-qualified table** —
// "sales.orders". Postgres has a level MongoDB does not, and folding it away
// would make two tables of the same name in different schemas one row.
export interface PostgresTableRef {
  readonly schema: string;
  readonly table: string;
}

// "sales.orders" → { schema, table }. A schema or table name may contain a dot,
// so the split is on the FIRST one and the remainder is the table — matching how
// listCollectionNames builds it. Unqualified means the search path's default,
// which is `public` for every install that has not changed it.
export function splitTableRef(collection: string): PostgresTableRef {
  const dot = collection.indexOf(".");
  if (dot === -1) return { schema: "public", table: collection };
  return { schema: collection.slice(0, dot), table: collection.slice(dot + 1) };
}

export function joinTableRef(ref: PostgresTableRef): string {
  return `${ref.schema}.${ref.table}`;
}

export class PostgresIndexCollector implements IndexCollector {
  constructor(
    private readonly conn: PostgresReader,
    // The workload read, which names its row rather than asking for one by type.
    // It IS the connection — that is the default and the only thing production
    // passes — but saying what this read returns is what lets its tests hand
    // over a complete object instead of asserting statements into `T[]`.
    private readonly workload: PostgresStatementSource = conn,
  ) {}

  // Ordinary and partitioned tables. A partitioned parent is included because
  // its indexes are the ones a reader manages; the partitions' own indexes are
  // attached copies and appear under their own names, which is why they are not
  // filtered out here — a detached partition is an ordinary table again.
  async listCollectionNames(database: string): Promise<string[]> {
    const rows = await this.query<{ collection: string }>(
      database,
      `SELECT n.nspname || '.' || c.relname AS collection
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname <> ALL($1::text[])
        ORDER BY 1`,
      [SYSTEM_SCHEMAS],
    );
    return rows.map((row) => row.collection);
  }

  // One row per index, with its keys in order.
  //
  // The catalog reads that make this exact rather than approximate, each probed
  // on 17.11:
  //   indoption[n] & 1     DESC on that key. NULL for an INCLUDE column, which
  //                        has no ordering at all — read as ascending.
  //   ord > indnkeyatts    this attribute is INCLUDEd rather than keyed.
  //   indkey = 0           an EXPRESSION index, whose text comes from
  //                        pg_get_indexdef(oid, n, true) — "lower(email)".
  //   indpred              the partial predicate, as SQL text.
  async listIndexes(database: string, collection: string): Promise<IndexSpec[]> {
    const { schema, table } = splitTableRef(collection);
    const rows = await this.query<{
      name: string;
      is_unique: boolean;
      is_primary: boolean;
      is_valid: boolean;
      is_ready: boolean;
      method: string;
      predicate: string | null;
      col: string;
      descending: boolean | null;
      is_include: boolean;
      ord: number;
    }>(
      database,
      `SELECT i.relname                                            AS name,
              ix.indisunique                                       AS is_unique,
              ix.indisprimary                                      AS is_primary,
              ix.indisvalid                                        AS is_valid,
              ix.indisready                                        AS is_ready,
              am.amname                                            AS method,
              pg_get_expr(ix.indpred, ix.indrelid)                 AS predicate,
              COALESCE(a.attname,
                       pg_get_indexdef(ix.indexrelid, k.ord::int, true)) AS col,
              CASE WHEN k.ord <= ix.indnkeyatts
                   THEN (ix.indoption[k.ord - 1] & 1) = 1 END      AS descending,
              k.ord > ix.indnkeyatts                               AS is_include,
              k.ord                                                AS ord
         FROM pg_index ix
         JOIN pg_class i     ON i.oid = ix.indexrelid
         JOIN pg_class t     ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_am am       ON am.oid = i.relam
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         LEFT JOIN pg_attribute a
                ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND t.relname = $2
        ORDER BY i.relname, k.ord`,
      [schema, table],
    );

    const specs = new Map<string, { spec: IndexSpec; keys: IndexKey[]; include: string[] }>();
    for (const row of rows) {
      let entry = specs.get(row.name);
      if (entry === undefined) {
        entry = {
          keys: [],
          include: [],
          spec: {
            name: row.name,
            keys: [],
            unique: row.is_unique,
            // No TTL index exists here. Age-based deletion is a job somebody
            // runs, which is what delete-patterns.ts looks for instead.
            ttl: false,
            partial: row.predicate !== null,
            // The predicate is SQL text, not a document. Kept under a single key
            // so two partial indexes are only interchangeable when they filter
            // on the same thing — which is what partialFilter exists to decide —
            // without pretending it can be compared field by field.
            partialFilter: row.predicate === null ? null : { sql: row.predicate },
            // Postgres indexes every row, including those whose key is NULL, so
            // nothing here is sparse in MongoDB's sense. A partial index whose
            // predicate is IS NOT NULL is the equivalent, and it is already
            // reported as partial with that predicate.
            sparse: false,
            // `indisvalid` false with `indisready` TRUE is this adapter's own
            // hide, and it does NOT set one — hideIndexes is false for
            // PostgreSQL (#303). False with indisready FALSE is a failed
            // CREATE INDEX CONCURRENTLY, which is a broken index rather than a
            // hidden one. Neither is "hidden", so this is always false and the
            // distinction is drawn in diagnose.ts where it can be explained.
            hidden: false,
            // A primary key is the closest thing to `_id_`: it is what the
            // never-drop rule protects, and dropping its index is refused by the
            // server anyway ("cannot drop index … because constraint … requires
            // it", verified).
            isShardKey: row.is_primary,
            collation: null,
          },
        };
        specs.set(row.name, entry);
      }
      if (row.is_include) entry.include.push(row.col);
      else entry.keys.push({ field: row.col, direction: row.descending === true ? -1 : 1 });
    }
    return [...specs.values()].map(({ spec, keys, include }) => ({
      ...spec,
      keys,
      ...(include.length > 0 ? { include } : {}),
    }));
  }

  // Per-index operation counters. One "member" per server, keyed by the host we
  // dialled: a standby keeps its OWN counters, so a cluster is read one node at
  // a time and each answers only for itself (#202).
  //
  // `since` is the honest floor rather than stats_reset alone. A crash discards
  // every counter AND sets stats_reset to NULL rather than restamping it
  // (measured on 17.11), so a null means either "never reset" or "a crash wiped
  // it" — and postmaster start time is under both.
  async collectUsage(database: string, collection: string): Promise<IndexUsageStat[]> {
    const { schema, table } = splitTableRef(collection);
    const identity = await this.conn.serverIdentity();
    const since = identity.statsReset ?? identity.startedAt;
    const rows = await this.query<{ index_name: string; ops: string | number }>(
      database,
      `SELECT indexrelname AS index_name, idx_scan AS ops
         FROM pg_stat_user_indexes
        WHERE schemaname = $1 AND relname = $2`,
      [schema, table],
    );
    return rows.map((row) => ({
      indexName: row.index_name,
      host: identity.member,
      ops: Number(row.ops ?? 0),
      since,
    }));
  }

  // "When was this index last used", which neither other engine can answer
  // directly. pg 16+ only — below it the column does not exist and the caller
  // falls back to the snapshot-delta inference every engine already uses, so
  // this returns an empty map rather than refusing (see version.ts).
  async collectLastUsed(database: string, collection: string): Promise<Map<string, string>> {
    const version = await this.conn.serverVersion();
    if (version === null || !postgresHasLastIdxScan(version)) return new Map();
    const { schema, table } = splitTableRef(collection);
    const rows = await this.query<{ index_name: string; last_used: string | null }>(
      database,
      `SELECT indexrelname AS index_name,
              to_char(last_idx_scan AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_used
         FROM pg_stat_user_indexes
        WHERE schemaname = $1 AND relname = $2`,
      [schema, table],
    );
    const used = new Map<string, string>();
    for (const row of rows) {
      if (row.last_used !== null) used.set(row.index_name, row.last_used);
    }
    return used;
  }

  // Bytes per index. `pg_relation_size` is the index's own main fork, which is
  // what a drop actually frees — deliberately not `pg_total_relation_size`,
  // which would add a TOAST table an index does not have.
  async indexSizes(database: string, collection: string): Promise<Record<string, number>> {
    const { schema, table } = splitTableRef(collection);
    const rows = await this.query<{ index_name: string; bytes: string | number }>(
      database,
      `SELECT i.relname AS index_name, pg_relation_size(ix.indexrelid) AS bytes
         FROM pg_index ix
         JOIN pg_class i     ON i.oid = ix.indexrelid
         JOIN pg_class t     ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2`,
      [schema, table],
    );
    const sizes: Record<string, number> = {};
    for (const row of rows) sizes[row.index_name] = Number(row.bytes ?? 0);
    return sizes;
  }

  // Table bytes and row count. Both are ESTIMATES and the row count especially:
  // `n_live_tup` is maintained from insert/update/delete counters and only
  // reconciled by ANALYZE, so a table written heavily since its last analyze
  // reports a number that is directionally right and precisely wrong. Every
  // caller uses it for scale — "is this index worth its size on a table this
  // big" — which is a question an estimate answers.
  async collectionStorage(
    database: string,
    collection: string,
  ): Promise<{ dataSizeBytes: number; docCount: number }> {
    const { schema, table } = splitTableRef(collection);
    const rows = await this.query<{ bytes: string | number; rows: string | number }>(
      database,
      `SELECT pg_table_size(s.relid) AS bytes, s.n_live_tup AS rows
         FROM pg_stat_user_tables s
        WHERE s.schemaname = $1 AND s.relname = $2`,
      [schema, table],
    );
    const row = rows[0];
    return { dataSizeBytes: Number(row?.bytes ?? 0), docCount: Number(row?.rows ?? 0) };
  }

  // Read latency for one table, from pg_stat_statements.
  //
  // ATTRIBUTION IS BY TEXT, and this is the weakest signal in the adapter —
  // stated rather than buried. PostgreSQL has no plan store and
  // pg_stat_statements carries no relation column, so the only link from a
  // statement to a table is the table's name appearing in the normalized SQL.
  // Matched on a word boundary so `sales.orders` does not also claim
  // `sales.orders_archive`, and it still cannot tell a table named in a comment
  // from one actually read.
  //
  // What makes it usable anyway: every consumer compares this measurement
  // against ITSELF over time, so a systematic attribution bias cancels. And on
  // this engine the read-latency regression gate does not run at all — there is
  // no hide, so apply.ts records no baseline (#303) — which means nothing
  // irreversible is decided from this number. It feeds the latency charts.
  async readLatency(database: string, collection: string): Promise<LatencyPair> {
    const rows = await this.statementTotals(database, collection, READ_PREFIXES);
    return rows;
  }

  async collectionLatency(
    database: string,
    collection: string,
  ): Promise<{ reads: LatencyPair; writes: LatencyPair }> {
    const [reads, writes] = await Promise.all([
      this.statementTotals(database, collection, READ_PREFIXES),
      this.statementTotals(database, collection, WRITE_PREFIXES),
    ]);
    return { reads, writes };
  }

  private async statementTotals(
    database: string,
    collection: string,
    prefixes: readonly string[],
  ): Promise<LatencyPair> {
    const ref = splitTableRef(collection);
    const rows = await this.query<{ calls: string | number; micros: string | number }>(
      database,
      `SELECT COALESCE(sum(calls), 0)                    AS calls,
              COALESCE(sum(total_exec_time) * 1000, 0)   AS micros
         FROM pg_stat_statements
        WHERE query ~* ('\\m' || $1 || '\\M')
          AND upper(btrim(query)) LIKE ANY($2::text[])`,
      [`${escapeRegex(ref.schema)}\\.${escapeRegex(ref.table)}`, prefixes],
    );
    const row = rows[0];
    return { ops: Number(row?.calls ?? 0), latencyMicros: Number(row?.micros ?? 0) };
  }

  // Indexes named explicitly by a query, which cannot be dropped safely because
  // removing one breaks its callers rather than slowing them.
  //
  // Always empty on PostgreSQL, and that is a fact about the engine rather than
  // a gap: core has no index hint syntax at all. `pg_hint_plan` adds one, but it
  // lives in a comment (`/*+ IndexScan(t idx) */`) that pg_stat_statements
  // normalizes away, so even where the extension is installed the hints are not
  // readable from any statistics view. Reported as none rather than guessed.
  async collectHintedIndexes(): Promise<string[]> {
    return [];
  }

  // Every namespace at once, which is why the port batches this: the workload
  // source is one cluster-wide store filtered per table, so a per-table
  // signature would read the whole of pg_stat_statements once per table.
  //
  // Grouped by database, because pg_stat_statements is per-database — a
  // statement run against `app` is not visible from `postgres`, which is the
  // same per-database boundary the pools exist for.
  async collectWorkload(
    targets: readonly WorkloadTarget[],
  ): Promise<Map<string, readonly QueryShape[]>> {
    const byDatabase = new Map<string, WorkloadTarget[]>();
    for (const target of targets) {
      const list = byDatabase.get(target.database) ?? [];
      list.push(target);
      byDatabase.set(target.database, list);
    }
    const shapes = new Map<string, readonly QueryShape[]>();
    for (const [database, group] of byDatabase) {
      // One database of many, so an unreachable one costs this answer that
      // database and not the others (#345). The single-database reads on this
      // collector let the failure through instead — there is no partial answer to
      // give about one database, so the decision belongs to the caller — but a
      // batched read across a cluster has to keep walking, the same way the
      // collect and suggest passes do.
      let statements: NormalizedStatement[];
      try {
        statements = await this.statementsFor(database);
      } catch (error) {
        if (error instanceof DatabaseInaccessibleError) continue;
        throw error;
      }
      for (const target of group) {
        const ref = splitTableRef(target.collection);
        const found: QueryShape[] = [];
        for (const statement of statements) {
          if (!attributesTo(statement.query, ref)) continue;
          const shape = shapeOf(statement);
          if (shape !== null) found.push(shape);
        }
        if (found.length > 0) shapes.set(workloadKey(target.database, target.collection), found);
      }
    }
    return shapes;
  }

  // Recurring age-based purges, read out of the same store.
  async collectDeletePatterns(database: string, collection: string): Promise<DeletePattern[]> {
    const ref = splitTableRef(collection);
    const patterns: DeletePattern[] = [];
    for (const statement of await this.statementsFor(database)) {
      if (!attributesTo(statement.query, ref)) continue;
      const pattern = deletePatternOf(statement);
      if (pattern !== null) patterns.push(pattern);
    }
    return patterns;
  }

  // MongoDB's profiler reports individual slow operations; pg_stat_statements
  // aggregates and keeps no per-execution rows at all, so there is nothing here
  // that "slow query" means. The create side reads collectWorkload instead,
  // which is the same information without the pretence of individual samples.
  async collectSlowQueries(): Promise<QueryShape[]> {
    return [];
  }

  collectServerHealth(): Promise<ServerHealth | null> {
    return collectPostgresHealth(this.conn);
  }

  collectNodes(): Promise<readonly ClusterNode[] | null> {
    return collectPostgresNodes(this.conn);
  }

  // Read once per database per pass. Bounded to the statements this pass could
  // act on: anything with no calls has nothing to say, and the store is capped
  // by pg_stat_statements.max anyway.
  private async statementsFor(database: string): Promise<NormalizedStatement[]> {
    try {
      const rows = await this.guarded(database, () =>
        this.workload.query(
          `SELECT query, calls, rows FROM pg_stat_statements WHERE calls > 0`,
          [],
          database,
        ),
      );
      // Coerced HERE, at the boundary, because `calls` and `rows` are bigint
      // columns and node-pg hands bigint back as a STRING — it will not narrow
      // one to a JS number on its own, since a bigint can exceed Number's exact
      // range. Left alone they travel as strings that look like numbers all the
      // way into `count`, where `count + 1` concatenates instead of adding. Found
      // by reading a real answer, not by a fixture that already held numbers.
      return rows.map((row) => ({
        query: typeof row.query === "string" ? row.query : "",
        calls: Number(row.calls ?? 0),
        rows: Number(row.rows ?? 0),
      }));
    } catch (error) {
      // An unreachable database is not a missing extension, and this read used to
      // report it as one (#345). It went straight at `this.conn.query` while every
      // other per-database read here goes through the classifier below — and the
      // lazy `poolFor(database)` dial happens inside it, so on the create side
      // this is the FIRST read to touch a database, not the last. A role without
      // CONNECT (42501) or a database dropped mid-pass (3D000) therefore read as
      // "no statements" and the pass carried on measuring a cluster it could not
      // see.
      if (error instanceof DatabaseInaccessibleError) throw error;
      // The extension is optional (WORKLOAD tier in diagnose.ts): without it the
      // drop side works as normal and there are simply no create-side
      // recommendations. `pg_stat_statements` missing answers 42P01, and its view
      // is SELECT-able by PUBLIC where the extension IS installed (`=r/postgres`
      // in its relacl, verified on 18.6), so this catch is not swallowing a
      // permission problem that should have dropped the database instead.
      return [];
    }
  }

  // Run against one database, turning the driver's "cannot connect" into the one
  // per-database failure the passes above must survive: an inaccessible database
  // contributes nothing and the rest of the cluster is still worth walking.
  private async query<T extends QueryResultRow>(
    database: string,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    return this.guarded(database, () => this.conn.query<T>(text, params, database));
  }

  // The classification itself, shared by both reads: the driver's "cannot
  // connect" becomes the one per-database failure the passes above must survive.
  private async guarded<T>(database: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (isDatabaseInaccessible(error)) throw new DatabaseInaccessibleError(database, error);
      throw error;
    }
  }
}

// Statement classes, matched on the leading keyword of the normalized text.
// `WITH` is a read here on purpose: a CTE that writes is rare and a data-modifying
// one still reports under its own INSERT/UPDATE/DELETE in most cases, so counting
// it as a read is the smaller error.
const READ_PREFIXES = ["SELECT%", "WITH%", "TABLE%"];
const WRITE_PREFIXES = ["INSERT%", "UPDATE%", "DELETE%", "MERGE%", "COPY%", "TRUNCATE%"];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 3D000 is "database does not exist"; 28000/28P01 are authentication and
// authorization failures against it. Anything else is a real fault and keeps
// aborting the pass, which is what a failure nobody has reasoned about should do.
const INACCESSIBLE_CODES = new Set(["3D000", "28000", "28P01", "42501"]);

function isDatabaseInaccessible(error: unknown): boolean {
  const code = field(error, "code");
  return typeof code === "string" && INACCESSIBLE_CODES.has(code);
}

// Does this normalized statement name that table? Word-bounded so `sales.orders`
// does not also claim `sales.orders_archive`, and schema-qualified because two
// tables of the same name in different schemas are different tables.
//
// A bare table name is accepted too: a statement written against the search path
// says `FROM orders`, which is by far the common case, and refusing it would
// leave most workloads invisible. The cost is that an unqualified `orders` in a
// database with two schemas containing one is attributed to both — over-counting
// rather than missing, which is the safer direction for a signal that must recur
// before it becomes a recommendation.
export function attributesTo(query: string, ref: PostgresTableRef): boolean {
  const table = escapeRegex(ref.table);
  // `\b`, not `\m`/`\M`. Those are PostgreSQL's word-boundary escapes and mean
  // nothing in JavaScript — as literals they made this never match, which showed
  // up as an empty workload rather than as an error.
  return new RegExp(`\\b(?:${escapeRegex(ref.schema)}\\.)?${table}\\b`, "i").test(query);
}
