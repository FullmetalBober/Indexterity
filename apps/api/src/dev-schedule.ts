import { clusters, createDatabase, eq, indexSnapshots } from "@repo/db";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { requiredEnv } from "./env";
import { taskList } from "./jobs/tasks";

// Demo the scheduler fan-out: enqueue the scheduleCollect dispatcher (as a cron
// tick would), then drain — it fans collect out to every cluster and processes.
async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const db = createDatabase(databaseUrl);

  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.addJob("scheduleCollect", {});
  await utils.release();
  await runOnce({ connectionString: databaseUrl, taskList });

  const clusterRows = await db.select({ id: clusters.id }).from(clusters);
  for (const row of clusterRows) {
    const snaps = await db
      .select()
      .from(indexSnapshots)
      .where(eq(indexSnapshots.clusterId, row.id));
    console.log(`cluster ${row.id.slice(0, 8)}: ${snaps.length} snapshots`);
  }
  process.exit(0);
}

void main();
