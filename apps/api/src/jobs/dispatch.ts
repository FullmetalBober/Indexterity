import type { JobHelpers } from "graphile-worker";
import { clusters } from "../db";
import { jobDb } from "./db";

// Fan a per-cluster data-plane task out to every connected cluster.
export async function dispatchToAllClusters(task: string, helpers: JobHelpers): Promise<number> {
  const db = jobDb();
  const rows = await db.select({ id: clusters.id }).from(clusters);
  for (const row of rows) {
    // Cap retries (5, exponential backoff) and dedup per cluster+task: a slow
    // or failing cluster replaces its pending job instead of piling new ones.
    await helpers.addJob(
      task,
      { clusterId: row.id },
      {
        maxAttempts: 5,
        jobKey: `${task}:${row.id}`,
        jobKeyMode: "replace",
      },
    );
  }
  helpers.logger.info(`scheduler: dispatched ${task} to ${rows.length} cluster(s)`);
  return rows.length;
}
