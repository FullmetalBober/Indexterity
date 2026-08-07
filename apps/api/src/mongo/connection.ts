import type { Db, MongoClient } from "mongodb";
import { mongoClient } from "./client";
import { parseServerVersion, type ServerVersion } from "./version";

// Owns a driver client. Created with an index-only role (the wiki's
// Architecture page, Security) so it cannot read customer documents.
export class MongoConnection {
  private readonly client: MongoClient;
  private version: ServerVersion | null | undefined;

  constructor(connectionString: string) {
    // Throws InsecureConnectionError on a string that would not connect over
    // validated TLS — see mongo/client.ts, which is the only place a driver
    // client is built.
    this.client = mongoClient(connectionString);
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  db(name: string): Db {
    return this.client.db(name);
  }

  // The server's version, cached: it cannot change under a live connection, and
  // every write asks for it.
  async serverVersion(): Promise<ServerVersion | null> {
    if (this.version !== undefined) return this.version;
    try {
      const info: unknown = await this.client.db("admin").command({ buildInfo: 1 });
      const raw = typeof info === "object" && info !== null ? Reflect.get(info, "version") : null;
      this.version = parseServerVersion(raw);
    } catch {
      // Unreadable version is treated as unsupported, never as "probably fine".
      this.version = null;
    }
    return this.version;
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
