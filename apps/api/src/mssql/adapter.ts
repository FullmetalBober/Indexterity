import type {
  EngineAdapter,
  EngineSession,
  IndexCollector,
  IndexExecutor,
  TlsOverrides,
} from "../engine/ports";
import { assertMssqlTlsEnforced } from "./client";
import { MssqlIndexCollector } from "./collector";
import { applyMssqlTlsOverrides, isMssqlConnString, mssqlHosts } from "./conn-string";
import { MssqlConnection } from "./connection";
import { diagnoseMssqlConnection } from "./diagnose";
import { MssqlIndexExecutor } from "./executor";

class MssqlEngineSession implements EngineSession {
  readonly collector: IndexCollector;

  constructor(private readonly conn: MssqlConnection) {
    this.collector = new MssqlIndexCollector(conn);
  }

  executor(readOnly: boolean): IndexExecutor {
    return new MssqlIndexExecutor(this.conn, readOnly);
  }

  // System databases are excluded inside listDatabaseNames itself.
  listDatabaseNames(): Promise<string[]> {
    return this.conn.listDatabaseNames();
  }

  ping(): Promise<void> {
    return this.conn.ping();
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}

// The SQL Server EngineAdapter (issue #36; mongo/adapter.ts is the reference
// shape). hideIndexes is true with the asymmetry settled there: DISABLE is the
// instant hide, REBUILD is the exact-but-not-instant undo, and the executor
// refuses the classes for which DISABLE is destructive.
export const mssqlAdapter: EngineAdapter = {
  engine: "MSSQL",
  capabilities: { hideIndexes: true, provisionScopedUsers: false },
  connStringHint: "mssql://user:password@host:1433 or Server=host;User Id=…;Password=…",
  isConnString: isMssqlConnString,
  hostsOf: mssqlHosts,
  assertSecureTransport: assertMssqlTlsEnforced,
  applySecureTransport: applyMssqlTlsOverrides,
  open: async (connectionString: string, overrides?: TlsOverrides): Promise<EngineSession> => {
    const conn = new MssqlConnection(connectionString, overrides);
    await conn.connect();
    return new MssqlEngineSession(conn);
  },
  diagnose: diagnoseMssqlConnection,
};
