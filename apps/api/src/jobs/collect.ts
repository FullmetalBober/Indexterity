import { indexSnapshots, latencySamples } from "../db";
import { collectSnapshots } from "../mongo";
import { openClusterMongo } from "./cluster-connection";
import { jobDb } from "./db";

// Collect index snapshots + per-collection read/write latency for a hosted-direct
// cluster into Postgres.
export async function collectCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const { conn, release } = await openClusterMongo(db, clusterId);
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
    release();
  }
}
