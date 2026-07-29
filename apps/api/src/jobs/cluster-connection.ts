import { clusters, type Database, envKeyProvider, eq, open } from "../db";
import { masterKeyBytesFor } from "../env";
import type { MongoConnection } from "../mongo";
import { acquireClusterConnection } from "./connection-pool";

export interface ClusterMongo {
  readonly conn: MongoConnection;
  readonly readOnly: boolean;
  // Return the connection to the pool — callers must not close it.
  readonly release: () => void;
}

// Load a cluster, unseal its connection string, and lease a pooled connection.
export async function openClusterMongo(db: Database, clusterId: string): Promise<ClusterMongo> {
  const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId)).limit(1);
  if (cluster === undefined) throw new Error(`cluster not found: ${clusterId}`);
  const connString = new TextDecoder().decode(
    await open(
      { dek: cluster.sealedDek, data: cluster.sealedData },
      envKeyProvider(masterKeyBytesFor(cluster.keyVersion)),
    ),
  );
  const { conn, release } = await acquireClusterConnection(clusterId, connString);
  return { conn, readOnly: cluster.readOnly, release };
}
