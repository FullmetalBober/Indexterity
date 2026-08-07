import type { Db, MongoClient } from "mongodb";
import { mongoClient, type TlsOverrides } from "./client";
import type { ResolvedConnection } from "./conn-string";
import { parseServerVersion, type ServerVersion } from "./version";

function stringsAt(hello: object, key: string): string[] {
  const value: unknown = Reflect.get(hello, key);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

// Every member of the set `hello` will admit to, which is TWO arrays and not one.
//
// `hosts` holds the members eligible to be elected. A member with `priority: 0`
// is reported under `passives` instead, and reading only `hosts` therefore misses
// it entirely — which is not an exotic configuration: priority 0 is the standard
// setting for a secondary in another region, precisely so it cannot win an
// election across a WAN. Measured on a 5-member 8.0 set (primary, 2 × priority 1,
// 1 × priority 0, 1 hidden), `hosts` named three of them and `passives` the
// fourth.
//
// Priority governs elections and nothing else, so a passive member serves
// `readPreference=secondaryPreferred` traffic like any other secondary. Not
// collecting from one is exactly the blind spot mongo/members.ts exists to close:
// its $indexStats are its own, so an index serving only that region reads as
// unused, and unused is what the drop pipeline acts on.
//
// The fifth member, the hidden one, is in neither array and stays invisible here.
// Seeing it needs replSetGetStatus or replSetGetConfig — cluster privileges the
// engine role does not ask for — and drivers never route reads to a hidden member
// anyway, so the exposure is narrower (direct-connected BI tools, backups). That
// is a privilege decision rather than a bug fix, and it is #99's stated scope.
export function membersFromHello(hello: unknown): string[] {
  if (typeof hello !== "object" || hello === null) return [];
  // Deduplicated because the two arrays are documented as disjoint and a
  // duplicate would cost a redundant connection per collect if they ever are not.
  return [...new Set([...stringsAt(hello, "hosts"), ...stringsAt(hello, "passives")])];
}

// Owns a driver client. Created with an index-only role (the wiki's
// Architecture page, Security) so it cannot read customer documents.
export class MongoConnection {
  private readonly client: MongoClient;
  private version: ServerVersion | null | undefined;

  // `overrides` is the cluster owner's recorded consent to skip specific
  // certificate checks. Omitted means none of them, which is the strict rule —
  // the direction a forgotten argument has to fail in.
  constructor(connectionString: string, overrides?: TlsOverrides) {
    // Throws InsecureConnectionError on a string that would not connect over
    // TLS, or one that disables a check nobody consented to — see
    // mongo/client.ts, the only place a driver client is built.
    this.client = mongoClient(connectionString, overrides);
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
  // a standalone and for a mongos (which has neither array — its shards do).
  async replicaMembers(): Promise<string[]> {
    const hello: unknown = await this.client.db("admin").command({ hello: 1 });
    return membersFromHello(hello);
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
