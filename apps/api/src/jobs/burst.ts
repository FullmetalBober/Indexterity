import { type Database, inArray, workerWatermarks } from "../db";
import { BURST_SCHEDULE, duePasses } from "./schedule";
import { claimWatermark, passKey } from "./watermark";

// The dispatch half of a tick: work out what became due and enqueue it.
//
// Written for burst mode (#212), where a whole process ran one tick and exited;
// since #231 the tick lives inside the api (jobs/tick.service.ts drains what
// this claims, with runOnce against the api's own pool) and #232 removed the
// burst entrypoint, so this is now the only scheduler the pipeline has. The
// property the whole design rests on is unchanged: a pass is claimed against
// its OCCURRENCE, so any number of concurrent tickers — interval, HTTP,
// replicas — dispatch each occurrence exactly once, with no lock.
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
