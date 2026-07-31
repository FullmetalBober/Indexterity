import type { CreateIndexOptions, IndexExecutor } from "../engine/ports";
import type { MongoConnection } from "./connection";

// The executor CONTRACT lives in the engine-neutral ports (../engine/ports);
// this file is the MongoDB implementation. Types re-exported for convenience.
export type { CreateIndexOptions, IndexExecutor } from "../engine/ports";

// Enforces read-only mode structurally: every write throws unless the cluster
// was explicitly switched to live mode (docs/architecture.md D11).
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
    await this.conn.db(database).command({
      collMod: collection,
      index: { name: indexName, hidden },
    });
  }

  async drop(database: string, collection: string, indexName: string): Promise<void> {
    this.assertWritable("drop index");
    await this.conn.db(database).collection(collection).dropIndex(indexName);
  }

  async create(
    database: string,
    collection: string,
    keys: Record<string, 1 | -1>,
    options: CreateIndexOptions,
  ): Promise<void> {
    this.assertWritable("create index");
    await this.conn.db(database).collection(collection).createIndex(keys, options);
  }
}
