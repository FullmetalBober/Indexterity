import { keyedIndexName } from "../engine/index-names";
import type { TunnelRoute } from "../engine/net-guard";
import type {
  DialProxy,
  EngineAdapter,
  EngineSession,
  FailureWatch,
  IndexCollector,
  IndexExecutor,
  PrivilegeChange,
  TlsOverrides,
} from "../engine/ports";
import { present } from "../errors/at";
import { applyTlsOverrides, assertTlsEnforced } from "./client";
import { MongoIndexCollector } from "./collector";
import { isMongoConnString, mongoHosts } from "./conn-string";
import { MongoConnection } from "./connection";
import { diagnoseConnection, privilegesOnConnection, REQUIRED_PRIVILEGES } from "./diagnose";
import { MongoIndexExecutor } from "./executor";
import { MongoFailureWatch } from "./failure-watch";
import { MemberConnections } from "./members";
import {
  connStringUsername,
  dropUserStatement,
  provisionScopedUser,
  upgradeEngineRole,
} from "./provision";
import { grantChangesStatement, ROLE_CHANGES } from "./role";
import { connectionFingerprint, sharedSelfReads } from "./self-reads";

class MongoEngineSession implements EngineSession {
  readonly collector: IndexCollector;
  readonly failureWatch: FailureWatch;
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
    // The self-read tally is keyed by the connection target and lives past this
    // session, which is the point: sessions are pooled and swept after five idle
    // minutes (jobs/connection-pool.ts), and a tally that died with one would
    // reset between every pair of hourly passes and never subtract anything.
    this.collector = new MongoIndexCollector(
      conn,
      this.members,
      sharedSelfReads(connectionFingerprint(connString)),
    );
    this.failureWatch = new MongoFailureWatch(conn, this.members);
  }

  executor(readOnly: boolean): IndexExecutor {
    return new MongoIndexExecutor(this.conn, readOnly);
  }

  checkPrivileges(observedDatabases: readonly string[] | null) {
    return privilegesOnConnection(this.conn, observedDatabases);
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

// The role's changes in the words its diagnose checks already use — one
// description of each privilege, not one here and one on the connect form.
const PRIVILEGE_CHANGES: readonly PrivilegeChange[] = ROLE_CHANGES.map((change) => {
  const check = present(
    REQUIRED_PRIVILEGES.find((required) => required.key === change.check),
    `the diagnose check for role change ${change.revision}`,
  );
  return {
    revision: change.revision,
    release: change.release,
    key: check.key,
    label: check.label,
    enables: check.enables,
  };
});

// The reference EngineAdapter (the wiki's Architecture page, Engine ports).
export const mongoAdapter: EngineAdapter = {
  engine: "MONGODB",
  // partialIndexFromConstants: the recommender's `{field: literal}` filter IS
  // a partialFilterExpression, so createIndexes takes it as it stands.
  capabilities: { hideIndexes: true, provisionScopedUsers: true, partialIndexFromConstants: true },
  connStringHint: "mongodb:// or mongodb+srv://",
  indexName: (_collection, keys, options) => keyedIndexName(keys, options),
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
  privilegeChanges: PRIVILEGE_CHANGES,
  grantChangesStatement,
  upgradeScopedUser: upgradeEngineRole,
};
