import { type Db, MongoClient } from "mongodb";
import type { ResolvedConnection } from "./conn-string";
import { parseServerVersion, type ServerVersion } from "./version";

// Owns a driver client. Created with an index-only role (the wiki's
// Architecture page, Security) so it cannot read customer documents.
export class MongoConnection {
  private readonly client: MongoClient;
  private version: ServerVersion | null | undefined;

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

  // What this client is actually connected with, as opposed to what its string
  // asked for. Only meaningful after connect(): an SRV deployment publishes
  // authSource in a DNS TXT record, and the driver merges it into `credentials`
  // during resolveSRVRecord — before that, `source` is still the database in the
  // path. `tls` is settled at parse time (the +srv scheme defaults it to true),
  // but it is read from the same place so there is one answer, not two.
  //
  // Feeds directConnectionTo, which has to rebuild a plain mongodb:// string and
  // would otherwise lose both. Safe to call unconnected — it reports what the
  // string alone says, which is the honest answer at that point.
  resolved(): ResolvedConnection {
    return {
      tls: this.client.options.tls,
      authSource: this.client.options.credentials?.source ?? null,
    };
  }

  async listDatabaseNames(): Promise<string[]> {
    const result = await this.client.db("admin").admin().listDatabases();
    return result.databases.map((entry) => entry.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
