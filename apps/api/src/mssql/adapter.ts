import type {
  DialProxy,
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
import { MssqlMemberConnections } from "./members";
import {
  dropLoginStatements,
  mssqlConnStringUsername,
  provisionMssqlScopedUser,
} from "./provision";

class MssqlEngineSession implements EngineSession {
  readonly collector: IndexCollector;
  private readonly members: MssqlMemberConnections;

  constructor(
    private readonly conn: MssqlConnection,
    connString: string,
    overrides?: TlsOverrides,
  ) {
    // Opened lazily on the first usage collection and held for the session's
    // life, so a three-replica group costs three connections rather than three
    // per collect. The replicas inherit the cluster's own consent: they are the
    // same cluster reached one node at a time, and a certificate the owner
    // accepted for it is accepted for its replicas too.
    this.members = new MssqlMemberConnections(conn, connString, overrides);
    this.collector = new MssqlIndexCollector(conn, this.members);
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

  async close(): Promise<void> {
    await this.members.close();
    await this.conn.close();
  }
}

// The SQL Server EngineAdapter (issue #36; mongo/adapter.ts is the reference
// shape). hideIndexes is true with the asymmetry settled there: DISABLE is the
// instant hide, REBUILD is the exact-but-not-instant undo, and the executor
// refuses the classes for which DISABLE is destructive.
export const mssqlAdapter: EngineAdapter = {
  engine: "MSSQL",
  capabilities: { hideIndexes: true, provisionScopedUsers: true },
  connStringHint: "mssql://user:password@host:1433 or Server=host;User Id=…;Password=…",
  isConnString: isMssqlConnString,
  hostsOf: mssqlHosts,
  assertSecureTransport: assertMssqlTlsEnforced,
  applySecureTransport: applyMssqlTlsOverrides,
  open: async (
    connectionString: string,
    overrides?: TlsOverrides,
    proxy?: DialProxy,
  ): Promise<EngineSession> => {
    const conn = new MssqlConnection(
      connectionString,
      overrides,
      proxy === undefined ? undefined : { proxy },
    );
    await conn.connect();
    return new MssqlEngineSession(conn, connectionString, overrides);
  },
  diagnose: diagnoseMssqlConnection,
  provisionScopedUser: provisionMssqlScopedUser,
  revokeStatements: dropLoginStatements,
  connStringUsername: mssqlConnStringUsername,
};
