import { createDatabase, indexSnapshots, latencySamples } from "../db";
import { requiredEnv } from "../env";
import { collectSnapshots } from "../mongo";
import { openClusterMongo } from "./cluster-connection";

// Collect index snapshots + per-collection read/write latency for a hosted-direct
// cluster into Postgres.
export async function collectCluster(clusterId: string): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const { conn } = await openClusterMongo(db, clusterId);
  try {
    const { snapshots, latency } = await collectSnapshots(conn);
    if (snapshots.length > 0) {
      await db
        .insert(indexSnapshots)
        .values(snapshots.map((snapshot) => ({ clusterId, ...snapshot })));
    }
    if (latency.length > 0) {
      await db.insert(latencySamples).values(latency.map((sample) => ({ clusterId, ...sample })));
    }
    return snapshots.length;
  } finally {
    await conn.close();
  }
}
