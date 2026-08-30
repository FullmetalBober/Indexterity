import { workerEnv } from "../config/env";
import { type Database, sql } from "../db";
import { BUDGETED_PASSES } from "./tasks";

// How long a lock has to have stood before it is read as abandoned rather than
// held. Four hours, which is graphile-worker's own constant for this — not a
// number chosen here (`dist/sql/resetLockedAt.js`, and the `job_expiry`
// default on `get_job`).
//
// It is a CEILING on how long a wedged queue stays wedged, and shortening it is
// paid for by the other side: a reset that fires while the worker is still
// working hands the same job to a second worker. So it can only be shortened for
// work whose length we KNOW, and until #407 we did not know any of it.
const STALE_LOCK_INTERVAL = "4 hours";

// The same thing for a pass that has a wall clock (#412).
//
// A budgeted pass cannot legitimately still be running past its own budget —
// that is what the budget means — so a lock older than the budget plus a margin
// is abandoned, whatever the library's general margin says. Four hours was right
// while any pass might legitimately be hours long; it is far too patient for one
// that gives up after five minutes.
//
// The margin is generous on purpose and multiplicative rather than additive: the
// budget bounds the pass, not the process around it, and the failure it guards
// against is the expensive one — resetting a live job's lock lets a second worker
// start the same pass beside it. Three budgets late costs a quarter of an hour of
// wedge; three budgets early costs two collects racing on one cluster, which is
// the outcome the named queues exist to prevent.
const BUDGETED_STALE_MULTIPLE = 3;

// `apply` and `finalize` are NOT in this set and must not be: they have no
// budget precisely because a build legitimately runs for tens of minutes (D118,
// #410), so their locks keep the library's four hours. Derived from the same
// constant the budget is applied from, so a pass added to one and forgotten in
// the other is not possible.
function budgetedStaleInterval(): string {
  const ms = workerEnv().CLUSTER_PASS_BUDGET_MS * BUDGETED_STALE_MULTIPLE;
  return `${Math.ceil(ms / 1000)} seconds`;
}

// Release locks left behind by a worker that died holding them.
//
// graphile-worker serialises per NAMED QUEUE, which is how one cluster's passes
// stay off each other's toes (`collect:<id>`, `probe:<id>`, …), and a queue is
// claimable only while `_private_job_queues.is_available` — a stored generated
// column, `locked_at IS NULL`, with no time term in it. Nothing in the claim
// path forgives an old lock. So a worker killed mid-job (SIGKILL, OOM, a node
// drain, a hot reload in dev) leaves that queue locked and every later job on
// it is never claimed again. The cluster silently stops being collected: the
// jobs sit at `attempts = 0`, so they never dead-letter, so the owner alert in
// runner.ts never fires either.
//
// The library clears these in `resetLockedAt`, scheduled from the resident
// `run()` path on a timer. #231/#232 left `runOnce` as the pipeline's only
// host, and `runOnce` -> `runOnceInternal` -> `_runTaskList(…, continuous:
// false)` never reaches that timer — so since then nothing has been resetting
// anything. This is that reset, run by the one thing that still drains.
//
// The two updates are the library's, verbatim in effect: the JOB's own lock has
// to go as well as the queue's, or the job stays unclaimable on a queue that is
// now free. `run_at` is pushed to now so a job unlocked from the past does not
// jump the line ahead of everything scheduled since.
//
// Returns the queue names that were freed. A freed queue is worth a log line —
// it means something died holding it, and that is the only trace left.
export async function releaseStaleLocks(db: Database): Promise<string[]> {
  // Two passes over the jobs, cheapest first. A budgeted pass is unlocked at its
  // own much shorter interval; everything else — `apply`, `finalize`, and any
  // task that is not a per-cluster pass at all — keeps the library's four hours.
  //
  // Matched on the task identifier rather than the queue name, because the queue
  // is `<task>:<clusterId>` and only the task half decides how long the work may
  // legitimately take.
  // A comma-joined string split server-side rather than an array parameter:
  // `${array}::text[]` is rejected as a cast (42846), and this keeps the list a
  // single bound parameter rather than interpolated SQL. Same shape the tick
  // suite uses to match on these identifiers.
  const budgeted = [...BUDGETED_PASSES].join(",");
  await db.execute(sql`
    update graphile_worker._private_jobs as j
       set locked_at = null, locked_by = null, run_at = greatest(j.run_at, now())
      from graphile_worker._private_tasks as t
     where t.id = j.task_id
       and t.identifier = any(string_to_array(${budgeted}, ','))
       and j.locked_at < now() - ${budgetedStaleInterval()}::interval`);
  await db.execute(sql`
    update graphile_worker._private_jobs
       set locked_at = null, locked_by = null, run_at = greatest(run_at, now())
     where locked_at < now() - ${STALE_LOCK_INTERVAL}::interval`);
  // And the QUEUES, on the same split. Unlocking a job is useless on its own —
  // the claim path also requires the queue to be available, so a budgeted job
  // freed at fifteen minutes would sit unclaimable behind a queue held for four
  // hours and the short interval would buy exactly nothing.
  //
  // The queue is named `<task>:<clusterId>`, so the task is the part before the
  // first colon. A queue whose name has no colon is not one of ours and falls to
  // the general interval below.
  const budgetedQueues = await db.execute<{ queue_name: string }>(sql`
    update graphile_worker._private_job_queues
       set locked_at = null, locked_by = null
     where split_part(queue_name, ':', 1) = any(string_to_array(${budgeted}, ','))
       and locked_at < now() - ${budgetedStaleInterval()}::interval
    returning queue_name`);
  const freed = await db.execute<{ queue_name: string }>(sql`
    update graphile_worker._private_job_queues
       set locked_at = null, locked_by = null
     where locked_at < now() - ${STALE_LOCK_INTERVAL}::interval
    returning queue_name`);
  return [...budgetedQueues.rows, ...freed.rows].map((row) => row.queue_name);
}
