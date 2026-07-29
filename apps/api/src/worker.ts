import { run } from "graphile-worker";
import { requiredEnv } from "./env";
import { drainPool } from "./jobs/connection-pool";
import { closeJobDb } from "./jobs/db";
import { taskList } from "./jobs/tasks";

// Recurring schedule (per cluster via the dispatcher tasks):
//  - collect + classify every 6h
//  - hide approved drops every 5 min
//  - finalize (drop past-observe hidden) hourly
//  - prune time-series tables past RETENTION_DAYS daily
const CRONTAB = [
  "0 */6 * * * scheduleCollect",
  "*/5 * * * * scheduleApply",
  "0 * * * * scheduleFinalize",
  "0 3 * * * retention",
].join("\n");

// Long-running background worker (deploy separately from the HTTP api).
async function main(): Promise<void> {
  const runner = await run({
    connectionString: requiredEnv("DATABASE_URL"),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    taskList,
    crontab: CRONTAB,
  });
  // Graceful shutdown: finish in-flight jobs, then drain every pool.
  const stop = async (): Promise<void> => {
    await runner.stop();
    await drainPool();
    await closeJobDb();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await runner.promise;
}

void main();
