import { type Db, MongoClient } from "mongodb";

// Owns a driver client. Created with an index-only role (see docs/architecture.md
// §9.1) so it cannot read customer documents.
export class MongoConnection {
  private readonly client: MongoClient;

  constructor(connectionString: string) {
    this.client = new MongoClient(connectionString);
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  db(name: string): Db {
    return this.client.db(name);
  }

  async listDatabaseNames(): Promise<string[]> {
    const result = await this.client.db("admin").admin().listDatabases();
    return result.databases.map((entry) => entry.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
