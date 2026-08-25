import type { CreateIndexOptions, IndexBuildOutcome, IndexExecutor } from "../engine/ports";
import { allowUntestedVersions, UnsupportedServerError } from "../engine/version";
import { splitTableRef } from "./collector";
import type { PostgresConnection } from "./connection";
import {
  CRON_APPLY_CALL_SQL,
  CRON_APPLY_PROBE_PARAMS,
  CRON_APPLY_PROBE_SQL,
  CRON_DATABASE_GUC,
  cronDirections,
  isUnrecognizedGuc,
  readCronApplyProbe,
} from "./cron-apply";
import { postgresVersionRefusal } from "./version";

// Raised by hide/unhide, which this engine cannot do at all.
//
// Its own class rather than a bare Error because the pipeline is supposed to
// have checked `capabilities.hideIndexes` long before reaching here (#303): this
// is the structural backstop, and when it fires it is a bug in the caller rather
// than anything the reader did. A named error is what makes that legible in a
// log instead of reading as a failed database call.
export class HideUnsupportedError extends Error {
  constructor(action: string) {
    super(
      `PostgreSQL has no reversible index hide, so ${action} is impossible here. ` +
        "The only mechanism is clearing pg_index.indisvalid, which needs superuser " +
        "and cannot be delegated — so this engine observes from statistics instead " +
        "and its capabilities report hideIndexes: false. A caller reaching this has " +
        "skipped that check.",
    );
    this.name = "HideUnsupportedError";
  }
}

// Double-quote an identifier for interpolation. Every name here comes from the
// catalog or from a recommendation built out of it, but quoting is not about
// trust: an index called `order` or `My Index` is legal and unquoted it is a
// syntax error. A literal double quote is doubled, which is the only escape SQL
// identifiers have.
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// The PostgreSQL write surface.
//
// hide/unhide throw, and that is the design rather than a gap — see #35's probe:
// HypoPG's hide affects only EXPLAIN (verified: EXPLAIN ANALYZE and ordinary
// queries in the same session still use the index), and clearing
// pg_index.indisvalid is superuser-only and undelegatable. Indexterity runs as
// the scoped role, so there is no hide to offer.
//
// What that costs, stated once: a drop here is irreversible AT THE MOMENT IT
// RUNS. The undo is a scripted rebuild from the spec recorded at drop time —
// exact, but minutes rather than instant. That is why every gate before it
// matters more on this engine than on the other two.
export class PostgresIndexExecutor implements IndexExecutor {
  constructor(
    private readonly conn: PostgresConnection,
    private readonly readOnly: boolean,
  ) {}

  // The cron apply route, resolved once per executor and then reused.
  //
  // Null means "not looked up yet"; the resolved value carries the cron database
  // and whether the function is there and callable. Cached because a build asks
  // for it per index and the answer cannot change inside one session in any way
  // that matters — a setup that appears mid-run is picked up on the next tick.
  private cronRoute: Promise<{ database: string; usable: boolean }> | null = null;

  private resolveCronRoute(): Promise<{ database: string; usable: boolean }> {
    if (this.cronRoute === null) {
      this.cronRoute = (async () => {
        const none = { database: "", usable: false };
        let database: string;
        try {
          const rows = await this.conn.query<Record<string, string>>(`SHOW ${CRON_DATABASE_GUC}`);
          const value = Object.values(rows[0] ?? {})[0];
          if (typeof value !== "string" || value.length === 0) return none;
          database = value;
        } catch (error) {
          // `unrecognized configuration parameter` is a server without pg_cron
          // preloaded, which is the ordinary case rather than a fault.
          if (isUnrecognizedGuc(error)) return none;
          return none;
        }
        try {
          const rows = await this.conn.query<{
            security_definer: boolean;
            executable: boolean;
            owner: string;
          }>(CRON_APPLY_PROBE_SQL, CRON_APPLY_PROBE_PARAMS, database);
          const probe = readCronApplyProbe(rows);
          return { database, usable: probe.installed && probe.executable };
        } catch {
          return { database, usable: false };
        }
      })();
    }
    return this.cronRoute;
  }

  // Whether this role can issue index DDL on the table itself. Ownership, or
  // membership of the owning role — the same test ownershipAcross makes in
  // diagnose.ts, asked here for the ONE table about to be indexed.
  private async ownsTable(database: string, schema: string, table: string): Promise<boolean> {
    try {
      const rows = await this.conn.query<{ owns: boolean }>(
        `SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owns
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
        database,
      );
      return rows[0]?.owns === true;
    } catch {
      return false;
    }
  }

  private assertWritable(action: string): void {
    if (this.readOnly) {
      throw new Error(`Cluster is read-only; refusing to ${action}.`);
    }
  }

  // Asked immediately before every write, not once at onboarding — the server
  // behind a connection string can change. Cached on the connection, so this is
  // a field read after the first call.
  //
  // A STANDBY is refused here too, and it is the same class of check: every
  // write fails on one anyway ("cannot execute … in a read-only transaction"),
  // and a refusal naming recovery is more use than the driver's.
  private async assertSupported(): Promise<void> {
    // The escape hatch was declared in the refusal message and read by nothing
    // until now, so a cluster on an untested major was refused with no way to
    // override — a message naming a knob that did not work.
    const refusal = postgresVersionRefusal(
      await this.conn.serverVersion(),
      allowUntestedVersions(),
    );
    if (refusal !== null) throw new UnsupportedServerError(refusal);
    const { inRecovery } = await this.conn.serverIdentity();
    if (inRecovery) {
      throw new UnsupportedServerError(
        "this server is in recovery (a standby), so it refuses every write. Point " +
          "Indexterity at the primary — a standby is worth reading for its own " +
          "usage counters and cannot apply anything",
      );
    }
  }

  hide(): Promise<void> {
    throw new HideUnsupportedError("hiding an index");
  }

  unhide(): Promise<void> {
    throw new HideUnsupportedError("un-hiding an index");
  }

  // DROP INDEX CONCURRENTLY: no ACCESS EXCLUSIVE lock on the table, so reads and
  // writes continue while it runs. Two things it demands, both verified on 17.11:
  //
  //   * it cannot run inside a transaction block, which is why this goes through
  //     `execute` on its own connection rather than a pooled `query`.
  //   * it refuses a constraint-backing index outright ("cannot drop index …
  //     because constraint … requires it"). That class is isNeverDrop upstream;
  //     the server refusing it as well is the backstop, and the message is
  //     better than anything this file would invent.
  //
  // IF EXISTS, because the pipeline's own pre-flight is a moment earlier and a
  // DBA can drop an index between the two. An absent index is the outcome the
  // caller wanted.
  async drop(database: string, collection: string, indexName: string): Promise<void> {
    this.assertWritable(`drop index ${indexName}`);
    await this.assertSupported();
    const { schema } = splitTableRef(collection);
    await this.conn.execute(
      `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(schema)}.${quoteIdent(indexName)}`,
      database,
    );
  }

  // CREATE INDEX CONCURRENTLY, which is how a build happens on a live table.
  //
  // Its failure mode is the one MongoDB and SQL Server do not have: a failed run
  // leaves an INVALID index behind — `indisvalid` false with `indisready` false —
  // which is not usable by the planner and still costs write overhead. It is not
  // cleaned up automatically. So a failure here drops the carcass before
  // rethrowing, or every retry leaves another one.
  async create(
    database: string,
    collection: string,
    keys: Record<string, 1 | -1>,
    options: CreateIndexOptions,
  ): Promise<IndexBuildOutcome> {
    const { schema, table } = splitTableRef(collection);
    const name = options.name ?? derivedName(table, keys);
    this.assertWritable(`create index ${name}`);
    await this.assertSupported();
    const columns = Object.entries(keys)
      .map(([field, direction]) => `${quoteIdent(field)}${direction === -1 ? " DESC" : ""}`)
      .join(", ");
    // INCLUDE is a real feature here (pg 11+), so unlike MongoDB the option is
    // honoured rather than dropped: an index rebuilt without its included
    // columns seeks the same and covers less, which no write-side gate notices.
    const include =
      options.include === undefined || options.include.length === 0
        ? ""
        : ` INCLUDE (${options.include.map(quoteIdent).join(", ")})`;
    // The partial predicate round-trips as the SQL text the collector read out of
    // `indpred`. Anything else would be this file inventing a predicate.
    const where = partialPredicate(options);
    // The scoped role owns nothing, so the direct build below would answer
    // `must be owner of table …`. The pg_cron route is what makes applying
    // possible for it at all (#332), and it is tried ONLY when ownership is
    // absent: a role that owns the table can build synchronously, which is
    // simpler, immediate, and does not depend on an extension.
    if (!(await this.ownsTable(database, schema, table))) {
      const route = await this.resolveCronRoute();
      if (route.usable) {
        // A partial index cannot go this way. The predicate is arbitrary SQL and
        // the function takes identifiers only, by design — so rather than
        // silently building an index WITHOUT its predicate, which would be a
        // different index than the one recommended, this refuses and says why.
        if (where !== "") {
          throw new Error(
            `refusing to build partial index ${name} through the pg_cron apply function: ` +
              "its predicate is arbitrary SQL and the function accepts identifiers only, " +
              "so the index would be built without the predicate. Apply this one with an " +
              "owner connection string.",
          );
        }
        await this.conn.query(
          CRON_APPLY_CALL_SQL,
          [
            database,
            schema,
            table,
            name,
            Object.keys(keys),
            cronDirections(keys),
            options.unique === true,
            options.include ?? [],
          ],
          route.database,
        );
        return "SCHEDULED";
      }
    }
    const statement =
      `CREATE${options.unique === true ? " UNIQUE" : ""} INDEX CONCURRENTLY ` +
      `IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(schema)}.${quoteIdent(table)} ` +
      `(${columns})${include}${where}`;
    try {
      await this.conn.execute(statement, database);
    } catch (error) {
      await this.dropInvalidLeftover(database, schema, name);
      throw error;
    }
    return "BUILT";
  }

  // Remove the invalid index a failed CREATE INDEX CONCURRENTLY leaves behind,
  // and ONLY that: the guard on `indisvalid = false AND indisready = false` is
  // what stops this from touching a healthy index of the same name that already
  // existed. Best-effort — if the cleanup itself fails the original error is
  // still the one worth reporting.
  private async dropInvalidLeftover(database: string, schema: string, name: string): Promise<void> {
    try {
      const rows = await this.conn.query<{ present: boolean }>(
        `SELECT true AS present
           FROM pg_index ix
           JOIN pg_class i     ON i.oid = ix.indexrelid
           JOIN pg_namespace n ON n.oid = i.relnamespace
          WHERE n.nspname = $1 AND i.relname = $2
            AND NOT ix.indisvalid AND NOT ix.indisready`,
        [schema, name],
        database,
      );
      if (rows.length === 0) return;
      await this.conn.execute(
        `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(schema)}.${quoteIdent(name)}`,
        database,
      );
    } catch {
      // Swallowed on purpose: the caller is about to see the real failure, and a
      // cleanup error on top of it would bury the cause.
    }
  }
}

// `WHERE …` for a partial index, or "". The collector stores the predicate under
// a single `sql` key precisely so this can put back exactly what it read; a
// shape it does not recognise yields a FULL index rather than a guessed
// predicate, because an index narrower than intended silently fails to serve
// queries nobody would think to check.
function partialPredicate(options: CreateIndexOptions): string {
  const filter = options.partialFilterExpression;
  if (filter === undefined) return "";
  const sql = (filter as { sql?: unknown }).sql;
  return typeof sql === "string" && sql.trim().length > 0 ? ` WHERE ${sql}` : "";
}

// A name in postgres's own style when the caller did not choose one:
// table_col1_col2_idx, which is what CREATE INDEX generates itself. Truncated to
// 63 bytes because that is the identifier limit, and an over-long name is
// silently truncated by the server — after which the name we recorded and the
// name on the cluster differ, and undo cannot find the index.
export function derivedName(table: string, keys: Record<string, 1 | -1>): string {
  const parts = [table, ...Object.keys(keys), "idx"];
  const name = parts.join("_").replace(/[^\w$]/g, "_");
  return Buffer.byteLength(name) <= 63 ? name : truncateToBytes(name, 63);
}

function truncateToBytes(value: string, limit: number): string {
  let out = value;
  while (Buffer.byteLength(out) > limit) out = out.slice(0, -1);
  return out;
}
