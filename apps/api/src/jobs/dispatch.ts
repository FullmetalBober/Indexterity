import { clusters, createDatabase } from "@repo/db";
import type { JobHelpers } from "graphile-worker";
import { requiredEnv } from "../env";

// Fan a per-cluster task out to every connected cluster. Used by the cron
// dispatcher tasks so one schedule covers all clusters.
export async function dispatchToAllClusters(task: string, helpers: JobHelpers): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const rows = await db.select({ id: clusters.id }).from(clusters);
  for (const row of rows) {
    await helpers.addJob(task, { clusterId: row.id });
  }
  helpers.logger.info(`scheduler: dispatched ${task} to ${rows.length} cluster(s)`);
  return rows.length;
}
