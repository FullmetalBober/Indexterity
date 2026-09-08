import { createHash } from "node:crypto";
import type { PlanAttribution } from "./collector";

// Plan attributions, held for longer than the connection that read them (#478).
//
// Attributing a Query Store plan means shipping its XML — tens of megabytes on a
// large store, and the entire budget of a collect reached over a tunnel. What a
// plan NAMES never changes for a given `(plan_id, query_plan_hash)`, so it is
// read once and remembered; that is D138, and it is why a warm collect is cheap.
//
// It was remembered on the COLLECTOR, which belongs to a pooled session, which
// `jobs/connection-pool.ts` closes after five idle minutes. So it was discarded
// on very nearly every cadence the pipeline has. Measured on the hosted
// deployment with 0.20.2 live: a collect SUCCEEDED at 01:03, and the collect one
// hour later reported `queryStore:planXml 269s/121 (still running)` — 121 chunks,
// about six thousand plans, which is what starting from empty looks like. The
// probe every five minutes flaps in and out of the same eviction.
//
// D138's own note is wrong twice over on this: it says the cache lives in the
// process so "a restarted process reads the store once". No restart is involved.
// It is every five idle minutes.
//
// So the cache lives here instead, and the connection is free to come and go.

// Total attributions held across every cluster and database before the least
// recently used are dropped.
//
// A ceiling rather than none, because this is no longer discarded for us: a plan
// attribution is a hash, a short table list and a boolean — call it a few hundred
// bytes with the runtime's overhead — so fifty thousand is single-digit
// megabytes, and the thing it replaces was already holding one cluster's worth.
// Reaching it costs a cold read of whichever database has gone longest unlooked
// at, which is the same cost as today's behaviour and only for that one.
const MAX_ATTRIBUTIONS = 50_000;

// `fingerprint/database`. The fingerprint is hex, so the separator cannot occur
// in it, and a database name may contain anything but is only ever the tail.
type CacheKey = string;

// Insertion-ordered on purpose: a JS Map iterates in insertion order and
// re-setting a key moves it to the end, which is the whole of the LRU.
const stores = new Map<CacheKey, Map<number, PlanAttribution>>();

/**
 * Which store a connection's attributions belong to.
 *
 * A hash of the connection string, which is exactly the identity the pool
 * already dooms an entry on when credentials rotate — same target, same cache;
 * rotated credentials, a new one. Hashed rather than used directly so a
 * credential is not also a map key held for the life of the process.
 */
export function connectionFingerprint(connString: string): string {
  return createHash("sha256").update(connString).digest("hex").slice(0, 32);
}

/**
 * What the collector reads and writes, narrowed to the two operations it makes.
 *
 * An interface rather than the module's functions, so a collector built outside
 * a session — `diagnose`, a test — gets a store of its own and cannot reach into
 * a shared one. That is also what keeps the tests from having to reset a global
 * between cases.
 */
export interface PlanAttributions {
  get(database: string): Map<number, PlanAttribution> | undefined;
  set(database: string, attributed: Map<number, PlanAttribution>): void;
}

function total(): number {
  let held = 0;
  for (const store of stores.values()) held += store.size;
  return held;
}

/** The process-wide store for one connection target. */
export function sharedAttributions(fingerprint: string): PlanAttributions {
  return {
    get: (database) => stores.get(`${fingerprint}/${database}`),
    set: (database, attributed) => {
      const key = `${fingerprint}/${database}`;
      // Deleted before being set so the key moves to the end of the iteration
      // order: without it a database written every collect would keep its
      // original position and be evicted ahead of one nothing has touched.
      stores.delete(key);
      stores.set(key, attributed);
      // Evict from the front — least recently written — until back under the
      // ceiling. Never the key just written, however large it is: dropping the
      // answer we are in the middle of using would make the ceiling a loop.
      for (const candidate of stores.keys()) {
        if (total() <= MAX_ATTRIBUTIONS) break;
        if (candidate === key) continue;
        stores.delete(candidate);
      }
    },
  };
}

/** A store belonging to one caller, for a collector that is not a session's. */
export function ownAttributions(): PlanAttributions {
  const mine = new Map<string, Map<number, PlanAttribution>>();
  return {
    get: (database) => mine.get(database),
    set: (database, at) => void mine.set(database, at),
  };
}

/** Forget everything. Tests only — nothing in the pipeline needs to. */
export function forgetAttributions(): void {
  stores.clear();
}

/** How much is held, for a test that asserts the ceiling holds. */
export function attributionsHeld(): number {
  return total();
}
