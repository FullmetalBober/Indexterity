import { type Runner, run } from "graphile-worker";
import { apiEnv, workerEnv } from "../config/env";
import type { Database } from "../db";
import { captureError } from "../errors/reporting";
import { ALERT_COOLDOWN_MS, alertAllowed, notifyClusterOwners } from "../mail/notify";
import { instrumentRunner } from "../metrics";
import { clusterIdOf, finalClusterFailure } from "./failure";
import { createTaskList } from "./tasks";
import { alertClaims } from "./watermark";

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
  // four minutes at 5,000 collections and 50ms. Load is not the constraint. Neither is
  // the read's payload any more: #64 is closed, and getLatencySeries is bounded on both
  // axes — a 30-day window over the top 8 collections, however often this runs.
  //
  // What is left is the write rate against the half of that read #64 did not bound.
  // Capping the RESPONSE did not cap the QUERY: loadLatencyReadings selects every
  // collection's rows inside the window and slices to the top 8 in JS afterwards, so
  // the rows a dashboard load scans are collections × this cadence × up to 30 days,
  // and latency_samples is the table where nothing run-length-collapses. Halving the
  // interval doubles that scan, and doubles the storage held inside RETENTION_DAYS.
  //
  // What it buys is 48 points a day instead of 24. That is not what the raise was for:
  // the floor was four a day reading as broken, and hourly clears it six times over.
  // The signal that has to be fast is scheduleProbe's, five minutes below.
  //
  // So hourly stays on its own merits, not on a blocker. What would change the answer
  // is downsampling old latency history and slicing that read in SQL — the cost side
  // would drop and the reader side would still say 24 is enough.
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
// `ownsSchedule` is the api's RUN_CRONJOB, passed rather than read: the
// standalone worker validates workerShape, which does not declare an api-only
// variable, so reading it here would throw in the one process that has always
// owned the schedule unconditionally.
export async function startWorker(db: Database, ownsSchedule = true): Promise<Runner> {
  const values = { ...workerEnv(), RUN_CRONJOB: ownsSchedule };
  const runner = await run({
    // graphile-worker keeps its OWN pool from this string, and should: it holds a
    // long-lived LISTEN connection, so sharing `db` would tie up one of that
    // pool's slots permanently and make the queue compete with everything else
    // for the rest.
    connectionString: values.DATABASE_URL,
    concurrency: values.WORKER_CONCURRENCY,
    // Derived rather than configured, and bounded rather than left at
    // graphile-worker's own default of 10 — separate from our pools is not the
    // same as unbounded, and seven idle backends per worker is a cost paid on the
    // DATABASE server. It needs one connection per job plus the LISTEN client, so
    // concurrency + 2 is the floor with a spare; deriving it means raising
    // WORKER_CONCURRENCY cannot leave the queue starved of connections.
    maxPoolSize: values.WORKER_CONCURRENCY + 2,
    // Ten seconds by default, against graphile-worker's own default of two.
    // Polling is the FALLBACK here, not the mechanism: add_job runs
    // `pg_notify('jobs:insert', …)` and this runner holds `LISTEN "jobs:insert"`,
    // so anything enqueued — including the dashboard's collect button — still
    // starts immediately. What waits up to this long is work that becomes due by
    // the clock: a cron tick, or a retry whose backoff expired. The tightest
    // schedule in CRONTAB is five minutes, so ten seconds of slack there costs
    // nothing and takes the idle query rate from 30 a minute to 6.
    //
    // Settable because that trade is the operator's: on metered postgres the
    // idle poll is a line on the bill, and a minute of extra retry latency is
    // cheaper than the transfer. Raising it never delays an ENQUEUED job.
    pollInterval: values.WORKER_POLL_INTERVAL_MS,
    // The db reaches every task through here — one argument at the composition
    // root, where before each task reached for a module-level singleton.
    taskList: createTaskList(db),
    // Installed only when THIS process owns the schedule. With RUN_CRONJOB=false
    // the clock is outside — something posts /api/internal/tick, which enqueues
    // the passes that became due — and installing the crontab as well would run
    // every pass twice, from two clocks that do not know about each other.
    //
    // graphile-worker treats an absent crontab as "no schedule", not as an
    // error, so the runner still claims, executes and retries exactly as before.
    ...(values.RUN_CRONJOB ? { crontab: CRONTAB } : {}),
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
    // The cooldown is a postgres claim now rather than an in-memory Map (#212),
    // so this arm is async — still fire-and-forget, because a mail failure must
    // not turn a dead-lettered job into an unhandled rejection.
    void (async () => {
      if (
        !(await alertAllowed(
          alertClaims(db),
          `${clusterId}:${job.task_identifier}`,
          ALERT_COOLDOWN_MS,
        ))
      ) {
        return;
      }
      await notifyClusterOwners(
        db,
        clusterId,
        `${job.task_identifier} keeps failing`,
        `The background ${job.task_identifier} task gave up after ${job.attempts} attempts.\n\n` +
          `Last error: ${String(error)}\n\n` +
          `Usual causes: the cluster is unreachable, the connection string changed, or the ` +
          `Indexterity user was removed. It will be retried on the next schedule tick.`,
      );
    })().catch((failure: unknown) => {
      captureError(failure, { task: job.task_identifier, clusterId });
    });
  });
  return runner;
}

// Embedded mode is opt-in and off by default: hosted runs the worker as its own
// deployment so an api rollout cannot abort an in-flight index build, and so the
// in-memory alert cooldown keeps its single-replica assumption. Small and
// self-hosted installs trade that for one container.
export function embeddedWorkerEnabled(): boolean {
  return apiEnv().RUN_WORKER;
}
