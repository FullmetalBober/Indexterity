import { mongoAdapter } from "../mongo/adapter";
import { mssqlAdapter } from "../mssql/adapter";
import type { ClusterEngine, EngineAdapter } from "./ports";

// The single place a new engine plugs in. A future adapter implements
// EngineAdapter (see ../mongo/adapter.ts for the reference implementation and
// the wiki's Architecture page, Engine ports, for the PostgreSQL mapping) and
// replaces its null here.
const adapters: Record<ClusterEngine, EngineAdapter | null> = {
  MONGODB: mongoAdapter,
  POSTGRESQL: null, // planned: pg_stat_user_indexes / pg_stat_statements (#35)
  MSSQL: mssqlAdapter,
};

export function engineSupported(engine: ClusterEngine): boolean {
  return adapters[engine] !== null;
}

export function supportedEngines(): ClusterEngine[] {
  return (Object.keys(adapters) as ClusterEngine[]).filter(engineSupported);
}

export function adapterFor(engine: ClusterEngine): EngineAdapter {
  const adapter = adapters[engine];
  if (adapter === null) {
    throw new Error(`engine not yet supported: ${engine}`);
  }
  return adapter;
}

// Which engine a pasted string belongs to, by asking each adapter's scheme
// guard. The schemes are disjoint on purpose (mongodb:// vs mssql:// vs ADO
// Server=…), so the first match is the only match. Null when nothing claims
// it — the caller falls back to its default and isConnString refuses with the
// engine's own hint.
export function detectEngine(connectionString: string): ClusterEngine | null {
  for (const adapter of Object.values(adapters)) {
    if (adapter?.isConnString(connectionString)) return adapter.engine;
  }
  return null;
}
