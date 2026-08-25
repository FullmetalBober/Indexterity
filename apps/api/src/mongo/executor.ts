import type { CreateIndexOptions, IndexBuildOutcome, IndexExecutor } from "../engine/ports";
import { UnsupportedServerError } from "../engine/version";
import type { MongoConnection } from "./connection";
import { versionRefusal } from "./version";

// Enforces read-only mode structurally: every write throws unless the cluster
// was explicitly switched to live mode (docs/decisions.md, D11).
export class MongoIndexExecutor implements IndexExecutor {
  constructor(
    private readonly conn: MongoConnection,
    private readonly readOnly: boolean,
  ) {}

  private assertWritable(action: string): void {
    if (this.readOnly) {
      throw new Error(`Cluster is read-only; refusing to ${action}.`);
    }
  }

  // Asked immediately before every write, not once at onboarding. A cluster can
  // be downgraded, or a connection string repointed at a different server, long
  // after we decided it was supported — and the cost of being wrong is a failed
  // or half-applied change on someone else's database. The version is cached on
  // the connection, so this is a field read after the first call.
  private async assertSupported(): Promise<void> {
    const refusal = versionRefusal(await this.conn.serverVersion());
    if (refusal !== null) throw new UnsupportedServerError(refusal);
  }

  hide(database: string, collection: string, indexName: string): Promise<void> {
    return this.setHidden(database, collection, indexName, true);
  }

  unhide(database: string, collection: string, indexName: string): Promise<void> {
    return this.setHidden(database, collection, indexName, false);
  }

  // Hiding is instant and reversible — the safety probe before an actual drop.
  private async setHidden(
    database: string,
    collection: string,
    indexName: string,
    hidden: boolean,
  ): Promise<void> {
    this.assertWritable(hidden ? "hide index" : "unhide index");
    await this.assertSupported();
    await this.conn.db(database).command({
      collMod: collection,
      index: { name: indexName, hidden },
    });
  }

  async drop(database: string, collection: string, indexName: string): Promise<void> {
    this.assertWritable("drop index");
    await this.assertSupported();
    await this.conn.db(database).collection(collection).dropIndex(indexName);
  }

  async create(
    database: string,
    collection: string,
    keys: Record<string, 1 | -1>,
    options: CreateIndexOptions,
  ): Promise<IndexBuildOutcome> {
    this.assertWritable("create index");
    await this.assertSupported();
    // `include` is a covering-column list, which MongoDB has no concept of —
    // createIndexes refuses an index specification field it does not recognise,
    // so it is dropped here rather than forwarded. Nothing is lost: no mongo
    // spec ever carries one.
    const { include: _include, ...mongoOptions } = options;
    await this.conn.db(database).collection(collection).createIndex(keys, mongoOptions);
    // createIndexes does not return until the index is usable, so there is
    // nothing for a later tick to finish.
    return "BUILT";
  }
}
