import type {
  EngineAdapter,
  EngineSession,
  IndexCollector,
  IndexExecutor,
  TlsOverrides,
} from "../engine/ports";
import { assertPgTlsEnforced } from "./client";
import { PostgresIndexCollector } from "./collector";
import { applyPgTlsOverrides, isPgConnString, pgConnStringUsername, pgHosts } from "./conn-string";
import { PostgresConnection } from "./connection";
import { diagnosePostgresConnection } from "./diagnose";
import { PostgresIndexExecutor } from "./executor";
import { dropRoleStatements, provisionPostgresScopedUser } from "./provision";

class PostgresEngineSession implements EngineSession {
  readonly collector: IndexCollector;

  constructor(private readonly conn: PostgresConnection) {
    this.collector = new PostgresIndexCollector(conn);
  }

  executor(readOnly: boolean): IndexExecutor {
    return new PostgresIndexExecutor(this.conn, readOnly);
  }

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

// The PostgreSQL EngineAdapter (issue #35; mongo/adapter.ts is the reference
// shape). Two capability answers differ from both other engines, and each is a
// measured fact about the engine rather than an unfinished piece of this adapter:
//
// hideIndexes is FALSE. There is no reversible index invisibility here. HypoPG's
// `hypopg_hide_index` affects only the non-executing EXPLAIN path — verified on
// 17.11, where EXPLAIN ANALYZE and ordinary queries in the same session kept
// using a "hidden" index — and the one mechanism that does work, clearing
// `pg_index.indisvalid`, needs superuser and cannot be delegated by GRANT. So the
// observe stage here is statistics-only, which #303 taught the pipeline to do.
//
// provisionScopedUsers is TRUE, and what it provisions is READ-ONLY. PostgreSQL
// has no grantable index privilege at all: only a table's owner may alter its
// indexes, and an owner can always SELECT. A single role that both analysed and
// applied would therefore be able to read every table it manages — so this one
// analyses, and applying takes the owner's own string, pasted deliberately. See
// provision.ts and the APPLY tier in diagnose.ts.
export const postgresAdapter: EngineAdapter = {
  engine: "POSTGRESQL",
  capabilities: { hideIndexes: false, provisionScopedUsers: true },
  connStringHint:
    "postgresql://user:password@host:5432/dbname?sslmode=verify-full or host=… port=5432 dbname=… user=…",
  isConnString: isPgConnString,
  hostsOf: pgHosts,
  assertSecureTransport: assertPgTlsEnforced,
  applySecureTransport: applyPgTlsOverrides,
  open: async (connectionString: string, overrides?: TlsOverrides): Promise<EngineSession> => {
    const conn = new PostgresConnection(connectionString, overrides);
    await conn.connect();
    return new PostgresEngineSession(conn);
  },
  diagnose: diagnosePostgresConnection,
  provisionScopedUser: provisionPostgresScopedUser,
  revokeStatements: dropRoleStatements,
  connStringUsername: pgConnStringUsername,
};
