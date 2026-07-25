import { clusters, type Database, envKeyProvider, eq, open } from "../db";
import { MongoConnection } from "../mongo";
import { masterKeyBytes } from "../env";

export interface ClusterMongo {
  readonly conn: MongoConnection;
  readonly demoMode: boolean;
}

// Load a cluster, unseal its connection string, and open a Mongo connection.
export async function openClusterMongo(db: Database, clusterId: string): Promise<ClusterMongo> {
  const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId)).limit(1);
  if (cluster === undefined) throw new Error(`cluster not found: ${clusterId}`);
  const connString = new TextDecoder().decode(
    await open(
      { dek: cluster.sealedDek, data: cluster.sealedData },
      envKeyProvider(masterKeyBytes()),
    ),
  );
  const conn = new MongoConnection(connString);
  await conn.connect();
  return { conn, demoMode: cluster.demoMode };
}
