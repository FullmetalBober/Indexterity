import { type Runner, run } from "graphile-worker";
import { requiredEnv } from "../env";
import { captureError } from "../errors/reporting";
import { ALERT_COOLDOWN_MS, alertAllowed, notifyClusterOwners } from "../mail/notify";
import { instrumentRunner } from "../metrics";
import { jobDb } from "./db";
import { clusterIdOf, finalClusterFailure } from "./failure";
import { taskList } from "./tasks";

// Recurring schedule (per cluster via the dispatcher tasks):
//  - collect + classify hourly
//  - workload analysis hourly (a missing index costs on every execution, so
//    waiting up to 6h to notice one is most of the delay)
//  - read-pressure probe every 5 min (a missing index shows up as latency long
//    before the next scheduled pass would notice)
//  - hide approved drops every 5 min
//  - finalize (drop past-observe hidden) hourly
//  - prune time-series tables past RETENTION_DAYS daily
//  - weekly read-only digest email (Monday 09:00)
const CRONTAB = [
  // Hourly, down from every six hours, and the number is bounded from both sides by
  // measurements rather than picked.
  //
  // Six hours was set by what storage cost, and #67 changed that — but only for the
  // half that goes stale. Measured on real data: index_snapshots collapses 76% of its
  // looks into an extended run, while latency_samples collapses NONE of them, max
  // observations 1 across every namespace with more than one look. $collStats totals
  // move on any operation, so a live collection differs at every look and there is
  // nothing to run-length. That table therefore scales strictly linearly with this
  // number while index_snapshots scales at about a quarter of it, and it is the one
  // that sets the ceiling.
  //
  // The floor is what a reader can see. Four points a day is not a trend, and the
  // latency panel reading as broken is what prompted this. Hourly makes it 24.
  //
  // Why not thirty minutes, which the load would allow: a collect takes 0.66s against
  // ~100 collections, and since collections are walked serially with five commands in
  // flight each, a remote cluster costs about one round trip per collection — roughly
  // four minutes at 5,000 collections and 50ms. Load is not the constraint. The
  // constraint is that getLatencySeries is still unbounded (#64) and there is no
  // downsampling of old latency history, so twelve times the rows would land on a
  // read that already has no limit. Hourly first, then that, then revisit.
  //
  // Offset from scheduleSuggest at :30 so the two hourly passes do not dial the same
  // cluster at the same minute.
  "0 * * * * scheduleCollect",
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
  // Job counters come off the same events, so they are registered here and
  // cover the embedded mode below as well as the standalone worker.
  instrumentRunner(runner);
  // The dead-letter transition, reported once (#31). Deliberately the LAST
  // attempt rather than every failure: graphile-worker retries, so reporting
  // each one turns a single fault into five events that say the same thing, and
  // how often a job retries is already a counter (instrumentRunner above). D28's
  // division holds — metrics say how often, errors say what.
  //
  // Every task, not only the per-cluster ones that notifyClusterOwners covers
  // below. `retention`, `digest` and the schedule dispatchers have no owner to
  // mail, so before this they were the failures with no audience at all.
  //
  // Nothing that the pipeline classifies reaches here: an unreachable cluster is
  // a handled condition the queue records as a SUCCESS (§7.4.1), so job:failed
  // is already only the unexpected ones.
  runner.events.on("job:failed", ({ job, error }) => {
    if (job.attempts >= job.max_attempts) {
      captureError(error, {
        task: job.task_identifier,
        attempt: job.attempts,
        clusterId: clusterIdOf(job.payload),
      });
    }
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
