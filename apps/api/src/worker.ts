import { run } from "graphile-worker";
import { requiredEnv } from "./env";
import { drainPool } from "./jobs/connection-pool";
import { closeJobDb, jobDb } from "./jobs/db";
import { finalClusterFailure } from "./jobs/failure";
import { taskList } from "./jobs/tasks";
import { notifyClusterOwners } from "./mail/notify";

// Recurring schedule (per cluster via the dispatcher tasks):
//  - collect + classify every 6h
//  - hide approved drops every 5 min
//  - finalize (drop past-observe hidden) hourly
//  - prune time-series tables past RETENTION_DAYS daily
//  - weekly read-only digest email (Monday 09:00)
const CRONTAB = [
  "0 */6 * * * scheduleCollect",
  "*/5 * * * * scheduleApply",
  "0 * * * * scheduleFinalize",
  "0 3 * * * retention",
  "0 9 * * 1 digest",
].join("\n");

// Long-running background worker (deploy separately from the HTTP api).
async function main(): Promise<void> {
  const runner = await run({
    connectionString: requiredEnv("DATABASE_URL"),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    taskList,
    crontab: CRONTAB,
  });
  // A cluster task that burns its last retry alerts the owners — a dead
  // connection string or revoked user otherwise fails silently forever.
  runner.events.on("job:failed", ({ job, error }) => {
    const clusterId = finalClusterFailure({
      taskIdentifier: job.task_identifier,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      payload: job.payload,
    });
    if (clusterId === null) return;
    void notifyClusterOwners(
      jobDb(),
      clusterId,
      `${job.task_identifier} keeps failing`,
      `The background ${job.task_identifier} task gave up after ${job.attempts} attempts.\n\n` +
        `Last error: ${String(error)}\n\n` +
        `Usual causes: the cluster is unreachable, the connection string changed, or the ` +
        `Indexterity user was removed. It will be retried on the next schedule tick.`,
    );
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
