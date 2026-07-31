import { type Db, MongoClient } from "mongodb";

// Owns a driver client. Created with an index-only role (see docs/architecture.md
// §10.1) so it cannot read customer documents.
export class MongoConnection {
  private readonly client: MongoClient;

  constructor(connectionString: string) {
    // Fail fast on unreachable clusters: 5s server selection instead of the
    // driver's 30s default, so requests surface a 502 quickly.
    this.client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000 });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  db(name: string): Db {
    return this.client.db(name);
  }

  // Replica-set members as the cluster itself reports them, or an empty list for
  // a standalone and for a mongos (which has no `hosts` — its shards do).
  async replicaMembers(): Promise<string[]> {
    const hello: unknown = await this.client.db("admin").command({ hello: 1 });
    if (typeof hello !== "object" || hello === null) return [];
    const hosts: unknown = Reflect.get(hello, "hosts");
    if (!Array.isArray(hosts)) return [];
    return hosts.filter((host): host is string => typeof host === "string");
  }

  async listDatabaseNames(): Promise<string[]> {
    const result = await this.client.db("admin").admin().listDatabases();
    return result.databases.map((entry) => entry.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
