import { type Database, sql } from "../db";

// How long a lock has to have stood before it is read as abandoned rather than
// held. Four hours, which is graphile-worker's own constant for this — not a
// number chosen here (`dist/sql/resetLockedAt.js`, and the `job_expiry`
// default on `get_job`).
//
// It is a CEILING on how long a wedged queue stays wedged, and shortening it
// would be paid for by the other side: a collect against a large cluster
// legitimately runs for minutes, and a reset that fires while the worker is
// still working hands the same job to a second worker. Waiting is the cheaper
// mistake, so the library's margin is kept rather than tuned.
const STALE_LOCK_INTERVAL = "4 hours";

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
  await db.execute(sql`
    update graphile_worker._private_jobs
       set locked_at = null, locked_by = null, run_at = greatest(run_at, now())
     where locked_at < now() - ${STALE_LOCK_INTERVAL}::interval`);
  const freed = await db.execute<{ queue_name: string }>(sql`
    update graphile_worker._private_job_queues
       set locked_at = null, locked_by = null
     where locked_at < now() - ${STALE_LOCK_INTERVAL}::interval
    returning queue_name`);
  return freed.rows.map((row) => row.queue_name);
}
