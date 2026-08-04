import { mongoAdapter } from "../mongo/adapter";
import type { ClusterEngine, EngineAdapter } from "./ports";

// The single place a new engine plugs in. A future adapter implements
// EngineAdapter (see ../mongo/adapter.ts for the reference implementation and
// the wiki's Architecture page, Engine ports, for the PostgreSQL/SQL Server
// mapping) and replaces its null here.
const adapters: Record<ClusterEngine, EngineAdapter | null> = {
  MONGODB: mongoAdapter,
  POSTGRESQL: null, // planned: pg_stat_user_indexes / pg_stat_statements
  MSSQL: null, // planned: sys.dm_db_index_usage_stats / Query Store
};

export function engineSupported(engine: ClusterEngine): boolean {
  return adapters[engine] !== null;
}

export function adapterFor(engine: ClusterEngine): EngineAdapter {
  const adapter = adapters[engine];
  if (adapter === null) {
    throw new Error(`engine not yet supported: ${engine}`);
  }
  return adapter;
}
