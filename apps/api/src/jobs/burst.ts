import { makeWorkerUtils, runOnce } from "graphile-worker";
import { workerEnv } from "../config/env";
import { type Database, inArray, workerWatermarks } from "../db";
import { BURST_SCHEDULE, duePasses } from "./schedule";
import { createTaskList } from "./tasks";
import { claimWatermark, passKey } from "./watermark";

// One burst tick: work out what became due, enqueue it, drain the queue, exit.
//
// The pipeline is timer-driven with no HTTP surface, so on a host that sleeps
// (Render free after 15 idle minutes) or suspends its database (Neon free at 100
// CU-hours) the resident runner does not degrade — it stops, and hidden indexes
// overrun their observe windows while drops stall mid-pipeline. An external
// scheduler ticking this instead makes such a host a SUPPORTED topology.
//
// The thing that makes it work at all, and the thing worth verifying before
// trusting any of it: `runOnce()` drains jobs enqueued DURING its own run, to
// any depth. Measured against postgres 17 with graphile-worker 0.17.3 — a
// dispatcher task enqueued two children, one child enqueued a grandchild, and a
// single runOnce ran all four. Without that, a tick would dispatch the
// per-cluster jobs and exit before running any of them, and the pipeline would
// be one pass behind forever.
export interface BurstResult {
  readonly dispatched: readonly string[];
  // Passes that were due but claimed by another tick first. Not an error — it
  // is the overlap guard doing its job — but worth returning so a tick can say
  // so rather than looking like it did nothing.
  readonly alreadyClaimed: readonly string[];
}

// Enqueue every pass whose occurrence has not been claimed yet.
//
// Deliberately NOT wrapped in one transaction. Each claim is its own atomic
// compare-and-set, so a tick killed half way through has dispatched some passes
// and not others — which is exactly the state the next tick is built to resume
// from. A transaction would instead hold a write lock across a fan-out that can
// take minutes, and roll back work that had already been enqueued.
export async function claimDuePasses(
  db: Database,
  addJob: (task: string) => Promise<unknown>,
  now: Date = new Date(),
): Promise<BurstResult> {
  const tasks = BURST_SCHEDULE.map((pass) => pass.task);
  const rows = await db
    .select({ key: workerWatermarks.key, at: workerWatermarks.at })
    .from(workerWatermarks)
    .where(
      inArray(
        workerWatermarks.key,
        tasks.map((task) => passKey(task)),
      ),
    );
  const lastDispatchedAt = new Map<string, Date>();
  for (const row of rows) lastDispatchedAt.set(row.key.slice("pass:".length), row.at);

  const dispatched: string[] = [];
  const alreadyClaimed: string[] = [];
  for (const { pass, occurrence } of duePasses(now, lastDispatchedAt)) {
    // Claim BEFORE enqueueing. The other order would let two ticks both enqueue
    // and then both stamp, and the cost of the failure is asymmetric: a claim
    // that succeeds and then fails to enqueue loses ONE occurrence of a pass
    // that recurs anyway, while a double dispatch runs the whole fleet twice
    // and spends a real dial budget doing it.
    if (!(await claimWatermark(db, passKey(pass.task), occurrence, now))) {
      alreadyClaimed.push(pass.task);
      continue;
    }
    await addJob(pass.task);
    dispatched.push(pass.task);
  }
  return { dispatched, alreadyClaimed };
}

export interface BurstLogger {
  info(message: string): void;
  error(message: string): void;
}

// The whole tick, including the drain. Returns what it dispatched so the
// entrypoint can print one honest line.
export async function runBurstTick(
  db: Database,
  logger: BurstLogger,
  now: Date = new Date(),
): Promise<BurstResult> {
  const values = workerEnv();
  const utils = await makeWorkerUtils({ connectionString: values.DATABASE_URL });
  let result: BurstResult;
  try {
    // The scheduler tasks take no payload and dedupe per cluster themselves
    // (jobs/dispatch.ts). The job key here is the second guard, for the window
    // between claiming and draining: a tick that claimed, enqueued, then died
    // leaves a pending job that the next tick must not duplicate.
    result = await claimDuePasses(
      db,
      (task) => utils.addJob(task, {}, { jobKey: `burst:${task}`, jobKeyMode: "preserve_run_at" }),
      now,
    );
  } finally {
    await utils.release();
  }
  logger.info(
    result.dispatched.length === 0
      ? `burst: nothing due${result.alreadyClaimed.length > 0 ? ` (${result.alreadyClaimed.length} claimed by another tick)` : ""}`
      : `burst: dispatched ${result.dispatched.join(", ")}`,
  );
  // Always drain, even with nothing dispatched: retries whose backoff expired
  // while the host slept are sitting in the queue, and they are most of what a
  // sleep-prone install has to catch up on.
  await runOnce({
    connectionString: values.DATABASE_URL,
    concurrency: values.WORKER_CONCURRENCY,
    maxPoolSize: values.WORKER_CONCURRENCY + 2,
    taskList: createTaskList(db),
  });
  return result;
}
