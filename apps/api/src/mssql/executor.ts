import {
  type CreateIndexOptions,
  type IndexBuildOutcome,
  IndexBuildRefusedError,
  type IndexExecutor,
} from "../engine/ports";
import { UnsupportedServerError } from "../engine/version";
import { type MssqlWriter, qualifiedTable, quoteIdent } from "./connection";
import { mssqlVersionRefusal } from "./version";

// The SQL Server write surface. hide/unhide are ALTER INDEX DISABLE/REBUILD —
// the design settled on #36:
//
//   DISABLE is instant (metadata-only, verified 4ms on 500k rows), deallocates
//   the b-tree (the observe window costs nothing), and keeps the definition on
//   the server, so the undo cannot restore the wrong thing.
//
//   REBUILD is the undo, and it costs a full index build. That asymmetry is
//   acceptable because unhide is the rare path (a regression, a cancel, an
//   offboard) — and it is bounded to indexes DISABLE is safe for at all:
//   disabling a clustered index takes the table offline (Msg 8655), disabling
//   a PK cascades into every referencing FK, and disabling ANY unique index
//   silently stops enforcing uniqueness, after which the rebuild itself can
//   fail on the duplicates that crept in. Those classes are all isNeverDrop
//   upstream; this file refuses them structurally so an upstream bug cannot
//   reach one.
// What sys.indexes answers about one index, and the only row this class reads.
// Named on the port rather than asked for per call: `query<T>` promises rows of
// whatever type the caller names, which no test double can honestly answer —
// the only value assignable to `T[]` for every `T` is `[]`. Fixing the row here
// lets the double just return index states.
export interface IndexStateRow {
  type: number;
  isUnique: boolean;
  isPrimaryKey: boolean;
  isUniqueConstraint: boolean;
  isDisabled: boolean;
}

export class MssqlIndexExecutor implements IndexExecutor {
  constructor(
    private readonly conn: MssqlWriter<IndexStateRow>,
    private readonly readOnly: boolean,
  ) {}

  private assertWritable(action: string): void {
    if (this.readOnly) {
      throw new Error(`Cluster is read-only; refusing to ${action}.`);
    }
  }

  // Asked immediately before every write, not once at onboarding — the server
  // behind a connection string can change. Cached on the connection, so this is
  // a field read after the first call.
  private async assertSupported(): Promise<void> {
    const refusal = mssqlVersionRefusal(await this.conn.serverVersion());
    if (refusal !== null) throw new UnsupportedServerError(refusal);
  }

  private async indexState(
    database: string,
    collection: string,
    indexName: string,
  ): Promise<IndexStateRow | null> {
    const rows = await this.conn.query(
      `SELECT i.type AS type, i.is_unique AS isUnique, i.is_primary_key AS isPrimaryKey,
              i.is_unique_constraint AS isUniqueConstraint, i.is_disabled AS isDisabled
       FROM ${quoteIdent(database)}.sys.indexes i
       WHERE i.object_id = OBJECT_ID(@qualified) AND i.name = @indexName`,
      { qualified: qualifiedTable(database, collection), indexName },
    );
    return rows[0] ?? null;
  }

  // The classes DISABLE must never touch, with the measured reason each time.
  private refusalToDisable(state: {
    type: number;
    isUnique: boolean;
    isPrimaryKey: boolean;
    isUniqueConstraint: boolean;
  }): string | null {
    if (state.type !== 2) {
      return "refusing to disable a clustered index: the whole table goes offline until it is rebuilt";
    }
    if (state.isPrimaryKey) {
      return "refusing to disable a primary key index: every referencing foreign key would be disabled with it";
    }
    if (state.isUniqueConstraint || state.isUnique) {
      return (
        "refusing to disable a unique index: uniqueness stops being enforced while it is " +
        "disabled, and re-enabling fails if duplicates arrived in the meantime"
      );
    }
    return null;
  }

  async hide(database: string, collection: string, indexName: string): Promise<void> {
    this.assertWritable("hide index");
    await this.assertSupported();
    const state = await this.indexState(database, collection, indexName);
    if (state === null) throw new Error(`index not found: ${indexName}`);
    if (state.isDisabled) return; // already hidden — idempotent, like collMod
    const refusal = this.refusalToDisable(state);
    if (refusal !== null) throw new Error(refusal);
    await this.conn.execute(
      `ALTER INDEX ${quoteIdent(indexName)} ON ${qualifiedTable(database, collection)} DISABLE`,
    );
  }

  async unhide(database: string, collection: string, indexName: string): Promise<void> {
    this.assertWritable("unhide index");
    await this.assertSupported();
    const state = await this.indexState(database, collection, indexName);
    if (state === null) throw new Error(`index not found: ${indexName}`);
    if (!state.isDisabled) return; // already visible — idempotent
    await this.rebuild(database, collection, indexName);
  }

  // ONLINE where the edition has it (Enterprise/Developer, Azure SQL, Managed
  // Instance), because the unhide that matters most is the emergency one on a
  // busy table. Some indexes cannot rebuild online even there (legacy LOB
  // types); those fall back to the offline rebuild every edition can do.
  private async rebuild(database: string, collection: string, indexName: string): Promise<void> {
    const statement = `ALTER INDEX ${quoteIdent(indexName)} ON ${qualifiedTable(database, collection)} REBUILD`;
    if (await this.conn.supportsOnlineRebuild()) {
      try {
        await this.conn.execute(`${statement} WITH (ONLINE = ON)`, { build: true });
        return;
      } catch {
        // Fall through to the offline rebuild — better a blocking unhide than
        // no unhide at all.
      }
    }
    await this.conn.execute(statement, { build: true });
  }

  async drop(database: string, collection: string, indexName: string): Promise<void> {
    this.assertWritable("drop index");
    await this.assertSupported();
    const state = await this.indexState(database, collection, indexName);
    if (state === null) throw new Error(`index not found: ${indexName}`);
    // The server refuses constraint-backing drops itself (a PK is dropped by
    // dropping the constraint); refusing here first gives the reason in our
    // words and keeps the executor's guarantees uniform with hide's.
    if (state.type !== 2 || state.isPrimaryKey || state.isUniqueConstraint) {
      throw new Error(
        "refusing to drop a clustered or constraint-backing index — that is a schema " +
          "change, not an index cleanup",
      );
    }
    await this.conn.execute(
      `DROP INDEX ${quoteIdent(indexName)} ON ${qualifiedTable(database, collection)}`,
    );
  }

  async create(
    database: string,
    collection: string,
    keys: Record<string, 1 | -1>,
    options: CreateIndexOptions,
  ): Promise<IndexBuildOutcome> {
    this.assertWritable("create index");
    await this.assertSupported();
    const columns = Object.entries(keys);
    if (columns.length === 0) throw new Error("cannot create an index with no keys");
    const name = options.name ?? `ix_${columns.map(([field]) => field).join("_")}`.slice(0, 128);
    const keyList = columns
      .map(([field, direction]) => `${quoteIdent(field)} ${direction === -1 ? "DESC" : "ASC"}`)
      .join(", ");
    // partialFilter round-trips through {definition} — the T-SQL predicate the
    // collector read off sys.indexes. A mongo-shaped filter cannot be
    // translated and refusing is better than building a different index than
    // the one being restored.
    //
    // A build refusal, not UnsupportedServerError: the server is fine, the
    // specification is what cannot be built, and the version class blocked a
    // production cluster as "wrong major" for exactly this (#452). The
    // recommender no longer proposes the shape for SQL Server
    // (capabilities.partialIndexFromConstants), so what still arrives here is a
    // row approved before it stopped — or a bug, and either way the pass records
    // it against the row and moves on.
    const filter = options.partialFilterExpression;
    let where = "";
    if (filter !== undefined && Object.keys(filter).length > 0) {
      const definition = filter.definition;
      if (typeof definition !== "string" || definition.length === 0) {
        throw new IndexBuildRefusedError(
          "cannot create a filtered index from a non-SQL filter expression",
        );
      }
      where = ` WHERE ${definition}`;
    }
    // INCLUDE goes before WHERE — the only order CREATE INDEX accepts. A column
    // named in both lists is rejected by the server (Msg 1911), so the key list
    // wins and the duplicate is dropped here rather than turned into a failed
    // undo.
    const keyFields = new Set(columns.map(([field]) => field));
    const included = (options.include ?? []).filter((column) => !keyFields.has(column));
    const include =
      included.length === 0 ? "" : ` INCLUDE (${included.map(quoteIdent).join(", ")})`;
    await this.conn.execute(
      `CREATE ${options.unique === true ? "UNIQUE " : ""}NONCLUSTERED INDEX ${quoteIdent(name)} ` +
        `ON ${qualifiedTable(database, collection)} (${keyList})${include}${where}`,
      // A build, so it gets the build budget rather than the pool's read budget.
      { build: true },
    );
    // CREATE INDEX returns when the index exists — ONLINE builds included.
    return "BUILT";
  }
}
