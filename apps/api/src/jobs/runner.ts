import type { WorkerEvents } from "graphile-worker";
import type { Database } from "../db";
import { captureError } from "../errors/reporting";
import { raiseAlert } from "../mail/notify";
import { NotifyService } from "../mail/notify.service";
import { instrumentRunner } from "../metrics";
import { clusterIdOf, finalClusterFailure } from "./failure";
import { alertClaims } from "./watermark";

// Everything the queue has to report, attached to ONE event stream per process.
//
// This file used to start graphile-worker's resident run() — the path that
// holds `LISTEN "jobs:insert"` and installs a crontab — for the standalone
// worker and the RUN_WORKER=true api alike. #231 replaced the api's runner with
// the tick (tick.service.ts: claim what became due, drain with runOnce), and
// #232 removed the standalone worker entirely, so the tick's drains are now the
// only thing that executes jobs and this wiring is what survived of the runner.
// The schedule those crontab lines expressed lives in jobs/schedule.ts as
// BURST_SCHEDULE, which the tick evaluates by occurrence.
//
// Wire it ONCE per process, not once per drain: instrumentRunner registers a
// gauge callback, and handlers stacked per tick would report every failure N
// times.
export function wireRunnerEvents(db: Database, events: WorkerEvents): void {
  // Job counters come off the queue's own events, so the numbers agree with
  // what the queue believes rather than with what a task remembered to report.
  instrumentRunner(events);
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
  events.on("job:failed", ({ job, error }) => {
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
  events.on("job:failed", ({ job, error }) => {
    const clusterId = finalClusterFailure({
      taskIdentifier: job.task_identifier,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      payload: job.payload,
    });
    if (clusterId === null) return;
    // The cooldown is a postgres claim rather than an in-memory Map (#212), so
    // this arm is async — still fire-and-forget, because a mail failure must
    // not turn a dead-lettered job into an unhandled rejection.
    //
    // Through `raiseAlert` rather than claim-then-send, so a dead-letter alert
    // the SMTP server refused is retried in minutes instead of lost for a day
    // (#419). This is the arm where losing it costs most: it is the one mail
    // that says a task has stopped retrying.
    void raiseAlert(alertClaims(db), `${clusterId}:${job.task_identifier}`, () =>
      new NotifyService(db).notifyClusterOwners(
        clusterId,
        `${job.task_identifier} keeps failing`,
        `The background ${job.task_identifier} task gave up after ${job.attempts} attempts.\n\n` +
          `Last error: ${String(error)}\n\n` +
          `Usual causes: the cluster is unreachable, the connection string changed, or the ` +
          `Indexterity user was removed. It will be retried on the next schedule tick.`,
      ),
    ).catch((failure: unknown) => {
      captureError(failure, { task: job.task_identifier, clusterId });
    });
  });
}
