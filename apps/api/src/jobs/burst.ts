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

/**
 * The two statements a tick runs against the watermark table.
 *
 * A port rather than `Database`, because the rule under test here — which
 * occurrence is due, and what a won or lost claim means — is not a rule about
 * drizzle. Passing the client meant the test had to fake a query builder it
 * could not construct and mock the claim module out from under the function;
 * both are gone, and the double below is now an object with two methods.
 */
export interface PassClaims {
  watermarks(keys: string[]): Promise<{ key: string; at: Date }[]>;
  // Claim unless something claimed this key at or after `notBefore`. That is the
  // postgres statement's rule, stated here so a double can hold it honestly.
  claim(key: string, notBefore: Date, now: Date): Promise<boolean>;
}

export function dbPassClaims(db: Database): PassClaims {
  return {
    watermarks: (keys) =>
      db
        .select({ key: workerWatermarks.key, at: workerWatermarks.at })
        .from(workerWatermarks)
        .where(inArray(workerWatermarks.key, keys)),
    claim: (key, notBefore, now) => claimWatermark(db, key, notBefore, now),
  };
}

// Enqueue every pass whose occurrence has not been claimed yet.
//
// Deliberately NOT wrapped in one transaction. Each claim is its own atomic
// compare-and-set, so a tick killed half way through has dispatched some passes
// and not others — which is exactly the state the next tick is built to resume
// from. A transaction would instead hold a write lock across a fan-out that can
// take minutes, and roll back work that had already been enqueued.
export async function claimDuePasses(
  claims: PassClaims,
  addJob: (task: string) => Promise<unknown>,
  now: Date = new Date(),
): Promise<BurstResult> {
  const tasks = BURST_SCHEDULE.map((pass) => pass.task);
  const rows = await claims.watermarks(tasks.map((task) => passKey(task)));
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
    if (!(await claims.claim(passKey(pass.task), occurrence, now))) {
      alreadyClaimed.push(pass.task);
      continue;
    }
    await addJob(pass.task);
    dispatched.push(pass.task);
  }
  return { dispatched, alreadyClaimed };
}
