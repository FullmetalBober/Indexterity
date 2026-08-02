import { type Runner, run } from "graphile-worker";
import { requiredEnv } from "../env";
import { ALERT_COOLDOWN_MS, alertAllowed, notifyClusterOwners } from "../mail/notify";
import { jobDb } from "./db";
import { finalClusterFailure } from "./failure";
import { taskList } from "./tasks";

// Recurring schedule (per cluster via the dispatcher tasks):
//  - collect + classify every 6h
//  - workload analysis hourly (a missing index costs on every execution, so
//    waiting up to 6h to notice one is most of the delay)
//  - read-pressure probe every 5 min (a missing index shows up as latency long
//    before the next scheduled pass would notice)
//  - hide approved drops every 5 min
//  - finalize (drop past-observe hidden) hourly
//  - prune time-series tables past RETENTION_DAYS daily
//  - weekly read-only digest email (Monday 09:00)
const CRONTAB = [
  "0 */6 * * * scheduleCollect",
  "30 * * * * scheduleSuggest",
  "*/5 * * * * scheduleApply",
  // Offset from scheduleApply so the two five-minute passes do not contend for
  // the same connections. Written out because graphile-worker's cron parser
  // takes a step on a whole field ("*/5") but not on a range ("2-59/5") — it
  // throws at startup, which takes the whole API down with RUN_WORKER=true.
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * * scheduleProbe",
  "0 * * * * scheduleFinalize",
  "0 3 * * * retention",
  "0 9 * * 1 digest",
].join("\n");

// Start the job runner. Used by the standalone worker process, and by the api
// itself when RUN_WORKER=true collapses both into one container.
export async function startWorker(): Promise<Runner> {
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
    if (!alertAllowed(`${clusterId}:${job.task_identifier}`, ALERT_COOLDOWN_MS)) return;
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
  return runner;
}

// Embedded mode is opt-in and off by default: hosted runs the worker as its own
// deployment so an api rollout cannot abort an in-flight index build, and so the
// in-memory alert cooldown keeps its single-replica assumption. Small and
// self-hosted installs trade that for one container.
export function embeddedWorkerEnabled(): boolean {
  return process.env.RUN_WORKER === "true";
}
