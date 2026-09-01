import { type Database, sql, workerWatermarks } from "../db";
import type { AlertClaims } from "../mail/notify";

// "Claim this key, but only if nothing has claimed it since `notBefore`."
//
// One conditional upsert, which is the whole of the concurrency story: two burst
// ticks firing seconds apart both compute the same due occurrence, both try to
// claim it, and postgres serialises the two writes so exactly one row-update
// happens. The loser gets false and dispatches nothing. No advisory lock, no
// transaction to hold open across a fan-out, nothing to leak if a tick is killed
// mid-run.
//
// `WHERE worker_watermarks.at < excluded.at` is what makes it a compare-and-set
// rather than a write: without it the second tick would overwrite the first's
// stamp and report success, which is exactly the double-dispatch the table
// exists to prevent.
export async function claimWatermark(
  db: Database,
  key: string,
  notBefore: Date,
  now: Date = new Date(),
): Promise<boolean> {
  // Stamped with `now` rather than with `notBefore`: the question a later claim
  // asks is "when did this last happen", and it happened now. Stamping the
  // occurrence would let a tick that ran late look like one that ran on time.
  const rows = await db
    .insert(workerWatermarks)
    .values({ key, at: now })
    .onConflictDoUpdate({
      target: workerWatermarks.key,
      set: { at: now },
      where: sql`${workerWatermarks.at} < ${notBefore.toISOString()}`,
    })
    .returning({ key: workerWatermarks.key });
  return rows.length > 0;
}

// Move a claim BACKWARD, so the next attempt at the same key is due sooner than
// the full cooldown would make it.
//
// The half of the claim story `claimWatermark` cannot express. That one is a
// compare-and-set forward — the guard that makes two ticks agree on who
// dispatches — and taking a claim is what makes the caller responsible for the
// work. When the work then fails in a way nothing retries (an alert mail the
// transport refused, #419), the claim has to be handed back or the failure has
// consumed the whole window and nobody hears about it.
//
// Unconditional, unlike the claim: there is no compare-and-set to make, because
// the only writer that reaches here is the tick that just won the claim, and no
// other tick can write this key until the stamp expires. What it writes is
// strictly older than what it is replacing, so a stray forward stamp cannot be
// clobbered by it either.
export async function deferWatermark(db: Database, key: string, at: Date): Promise<void> {
  await db
    .insert(workerWatermarks)
    .values({ key, at })
    .onConflictDoUpdate({ target: workerWatermarks.key, set: { at } });
}

// What the key looks like, in one place, so a typo cannot silently create a
// second watermark that never collides with the first.
export function passKey(pass: string): string {
  return `pass:${pass}`;
}

export function alertKey(scope: string): string {
  return `alert:${scope}`;
}

// The alert cooldown's store, as the one pair mail/notify.ts asks for. Its
// own namespace in the same table: a pass and an alert are the same operation
// over different keys, and giving each a second table would have been two
// migrations to say one thing.
export function alertClaims(db: Database): AlertClaims {
  return {
    claim: (key, notBefore, now) => claimWatermark(db, alertKey(key), notBefore, now),
    defer: (key, at) => deferWatermark(db, alertKey(key), at),
  };
}
