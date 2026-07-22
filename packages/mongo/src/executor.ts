import type { MongoConnection } from "./connection";

export interface CreateIndexOptions {
  readonly name?: string;
  readonly unique?: boolean;
}

export interface IndexExecutor {
  hide(database: string, collection: string, indexName: string): Promise<void>;
  unhide(database: string, collection: string, indexName: string): Promise<void>;
  drop(database: string, collection: string, indexName: string): Promise<void>;
  create(
    database: string,
    collection: string,
    keys: Record<string, 1 | -1>,
    options: CreateIndexOptions,
  ): Promise<void>;
}

// Enforces demo/read-only mode structurally: every write throws unless the
// cluster was explicitly taken out of demo mode (docs/architecture.md D11).
export class MongoIndexExecutor implements IndexExecutor {
  constructor(
    private readonly conn: MongoConnection,
    private readonly demoMode: boolean,
  ) {}

  private assertWritable(action: string): void {
    if (this.demoMode) {
      throw new Error(`Cluster is in demo mode; refusing to ${action}.`);
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
