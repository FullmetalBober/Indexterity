import { createDatabase, indexSnapshots } from "../db";
import { collectSnapshots } from "../mongo";
import { requiredEnv } from "../env";
import { openClusterMongo } from "./cluster-connection";

// Collect index snapshots for a hosted-direct cluster into Postgres. (Agent-mode
// clusters push their own snapshots and are never dispatched this job.)
export async function collectCluster(clusterId: string): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const { conn } = await openClusterMongo(db, clusterId);
  try {
    const snapshots = await collectSnapshots(conn);
    if (snapshots.length > 0) {
      await db
        .insert(indexSnapshots)
        .values(snapshots.map((snapshot) => ({ clusterId, ...snapshot })));
    }
    return snapshots.length;
  } finally {
    await conn.close();
  }
}
