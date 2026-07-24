import { clusters, createDatabase, eq } from "@repo/db";
import type { JobHelpers } from "graphile-worker";
import { requiredEnv } from "../env";

// Fan a data-plane task out to every hosted-direct cluster. Agent-mode clusters
// run their own data plane (the agent), so the worker never dispatches to them.
export async function dispatchToAllClusters(task: string, helpers: JobHelpers): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const rows = await db
    .select({ id: clusters.id })
    .from(clusters)
    .where(eq(clusters.connectionMode, "HOSTED_DIRECT"));
  for (const row of rows) {
    await helpers.addJob(task, { clusterId: row.id });
  }
  helpers.logger.info(`scheduler: dispatched ${task} to ${rows.length} cluster(s)`);
  return rows.length;
}
