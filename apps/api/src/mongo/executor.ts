import type { CreateIndexOptions, IndexExecutor } from "../engine/ports";
import type { MongoConnection } from "./connection";
import { versionRefusal } from "./version";

// The server cannot do what the pipeline requires. Distinct from a network
// failure and from a permission failure: retrying will never fix it, so the
// jobs treat it as a condition to report rather than an error to retry.
export class UnsupportedServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedServerError";
  }
}

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
  ): Promise<void> {
    this.assertWritable("create index");
    await this.assertSupported();
    await this.conn.db(database).collection(collection).createIndex(keys, options);
  }
}
