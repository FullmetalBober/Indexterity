import type { EngineAdapter, EngineSession, IndexCollector, IndexExecutor } from "../engine/ports";
import { MongoIndexCollector } from "./collector";
import { isMongoConnString, mongoHosts } from "./conn-string";
import { MongoConnection } from "./connection";
import { diagnoseConnection } from "./diagnose";
import { MongoIndexExecutor } from "./executor";
import { MemberConnections } from "./members";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);

class MongoEngineSession implements EngineSession {
  readonly collector: IndexCollector;
  private readonly members: MemberConnections;

  constructor(
    private readonly conn: MongoConnection,
    connString: string,
  ) {
    // Opened lazily on the first usage collection and held for the session's
    // life, so a 3-member set costs 3 connections rather than 3 per collect.
    this.members = new MemberConnections(conn, connString);
    this.collector = new MongoIndexCollector(conn, this.members);
  }

  executor(readOnly: boolean): IndexExecutor {
    return new MongoIndexExecutor(this.conn, readOnly);
  }

  async listDatabaseNames(): Promise<string[]> {
    const names = await this.conn.listDatabaseNames();
    return names.filter((name) => !SYSTEM_DATABASES.has(name));
  }

  async ping(): Promise<void> {
    await this.conn.db("admin").command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.members.close();
    await this.conn.close();
  }
}

// The reference EngineAdapter (the wiki's Architecture page, Engine ports).
export const mongoAdapter: EngineAdapter = {
  engine: "MONGODB",
  capabilities: { hideIndexes: true, provisionScopedUsers: true },
  isConnString: isMongoConnString,
  hostsOf: mongoHosts,
  open: async (connectionString: string): Promise<EngineSession> => {
    const conn = new MongoConnection(connectionString);
    await conn.connect();
    return new MongoEngineSession(conn, connectionString);
  },
  diagnose: diagnoseConnection,
};
