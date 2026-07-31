import { clusters, type Database, envKeyProvider, eq, open } from "../db";
import type { ClusterEngine, EngineSession } from "../engine/ports";
import { masterKeyBytesFor } from "../env";
import { acquireClusterSession } from "./connection-pool";

export interface ClusterSession {
  readonly session: EngineSession;
  readonly engine: ClusterEngine;
  readonly readOnly: boolean;
  // Return the session to the pool — callers must not close it.
  readonly release: () => void;
}

// Load a cluster, unseal its connection string, and lease a pooled session for
// its engine.
export async function openClusterSession(db: Database, clusterId: string): Promise<ClusterSession> {
  const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId)).limit(1);
  if (cluster === undefined) throw new Error(`cluster not found: ${clusterId}`);
  const connString = new TextDecoder().decode(
    await open(
      { dek: cluster.sealedDek, data: cluster.sealedData },
      envKeyProvider(masterKeyBytesFor(cluster.keyVersion)),
    ),
  );
  const { session, release } = await acquireClusterSession(clusterId, cluster.engine, connString);
  return { session, engine: cluster.engine, readOnly: cluster.readOnly, release };
}
