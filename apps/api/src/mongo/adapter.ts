import type { TunnelRoute } from "../engine/net-guard";
import type {
  DialProxy,
  EngineAdapter,
  EngineSession,
  IndexCollector,
  IndexExecutor,
  TlsOverrides,
} from "../engine/ports";
import { applyTlsOverrides, assertTlsEnforced } from "./client";
import { MongoIndexCollector } from "./collector";
import { isMongoConnString, mongoHosts } from "./conn-string";
import { MongoConnection } from "./connection";
import { diagnoseConnection } from "./diagnose";
import { MongoIndexExecutor } from "./executor";
import { MemberConnections } from "./members";
import { connStringUsername, dropUserStatement, provisionScopedUser } from "./provision";

class MongoEngineSession implements EngineSession {
  readonly collector: IndexCollector;
  private readonly members: MemberConnections;

  constructor(
    private readonly conn: MongoConnection,
    connString: string,
    overrides?: TlsOverrides,
    proxy?: DialProxy,
    route?: TunnelRoute,
  ) {
    // Opened lazily on the first usage collection and held for the session's
    // life, so a 3-member set costs 3 connections rather than 3 per collect.
    // The members inherit the cluster's own consent: they are the same cluster,
    // reached one node at a time, and a certificate the owner accepted for it is
    // accepted for its members too.
    this.members = new MemberConnections(conn, connString, overrides, proxy, route);
    this.collector = new MongoIndexCollector(conn, this.members);
  }

  executor(readOnly: boolean): IndexExecutor {
    return new MongoIndexExecutor(this.conn, readOnly);
  }

  // System databases are excluded inside listDatabaseNames itself, the way the
  // other two adapters do it.
  listDatabaseNames(): Promise<string[]> {
    return this.conn.listDatabaseNames();
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
  // partialIndexFromConstants: the recommender's `{field: literal}` filter IS
  // a partialFilterExpression, so createIndexes takes it as it stands.
  capabilities: { hideIndexes: true, provisionScopedUsers: true, partialIndexFromConstants: true },
  connStringHint: "mongodb:// or mongodb+srv://",
  isConnString: isMongoConnString,
  hostsOf: mongoHosts,
  assertSecureTransport: assertTlsEnforced,
  applySecureTransport: applyTlsOverrides,
  open: async (
    connectionString: string,
    overrides?: TlsOverrides,
    proxy?: DialProxy,
    route?: TunnelRoute,
  ): Promise<EngineSession> => {
    const conn = new MongoConnection(connectionString, overrides, proxy);
    await conn.connect();
    // The proxy AND the route go to the session, because the members it discovers
    // later are dialled through the one and judged by the other (#382).
    return new MongoEngineSession(conn, connectionString, overrides, proxy, route);
  },
  diagnose: diagnoseConnection,
  provisionScopedUser,
  revokeStatements: dropUserStatement,
  connStringUsername,
};
