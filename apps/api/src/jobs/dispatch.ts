import { clusters, createDatabase } from "@repo/db";
import type { JobHelpers } from "graphile-worker";
import { requiredEnv } from "../env";

// Fan a per-cluster data-plane task out to every connected cluster.
export async function dispatchToAllClusters(task: string, helpers: JobHelpers): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const rows = await db.select({ id: clusters.id }).from(clusters);
  for (const row of rows) {
    await helpers.addJob(task, { clusterId: row.id });
  }
  helpers.logger.info(`scheduler: dispatched ${task} to ${rows.length} cluster(s)`);
  return rows.length;
}
