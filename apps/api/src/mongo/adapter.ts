import type { EngineAdapter, EngineSession, IndexCollector, IndexExecutor } from "../engine/ports";
import { MongoIndexCollector } from "./collector";
import { isMongoConnString } from "./conn-string";
import { MongoConnection } from "./connection";
import { diagnoseConnection } from "./diagnose";
import { MongoIndexExecutor } from "./executor";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);

class MongoEngineSession implements EngineSession {
  readonly collector: IndexCollector;

  constructor(private readonly conn: MongoConnection) {
    this.collector = new MongoIndexCollector(conn);
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

  close(): Promise<void> {
    return this.conn.close();
  }
}

// The reference EngineAdapter (docs/architecture.md §"Engine ports").
export const mongoAdapter: EngineAdapter = {
  engine: "MONGODB",
  capabilities: { hideIndexes: true, provisionScopedUsers: true },
  isConnString: isMongoConnString,
  open: async (connectionString: string): Promise<EngineSession> => {
    const conn = new MongoConnection(connectionString);
    await conn.connect();
    return new MongoEngineSession(conn);
  },
  diagnose: diagnoseConnection,
};
