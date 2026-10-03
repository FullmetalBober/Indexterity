import { createHash } from "node:crypto";
import { getHeapStatistics } from "node:v8";
import type { PlanAttribution } from "./collector";
import type { PlanWorkload } from "./plan-facts";

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
//
// Since #588 an entry also carries what suggest reads off the same XML — shapes,
// the server's missing-index suggestions, purges (plan-facts.ts) — once a
// suggest has needed them. The collect never parses a plan that far, and either
// pass's shipping fills what the other would have shipped again.

// How much the stores may hold before the least recently written give plans up.
//
// In BYTES, estimated per entry below, and sized from the heap rather than fixed.
// It was fifty thousand attributions, on the claim that this was single-digit
// megabytes: measured, an attribution is ~255 bytes even with its table names
// shared, so fifty thousand was ~12 MiB — and a production SQL Server whose store
// sat near that count crossed it, after which every pass re-shipped a database of
// ~5,000 plans and timed out (#588). A count cannot tell a fifty-plan database
// from one with suggest's facts on every plan (~550 bytes an entry), and a fixed
// number is wrong at both ends of the hosts this runs on.
//
// Ten percent of the heap limit, between 8 and 256 MiB. Measured on the
// 512 MB all-in-one, whose api gets a 205 MiB old space: the heap limit is
// ~301 MiB and the api idles at ~63 MiB, so ~30 MiB of plans leaves a pass its
// room. That holds ~120,000 attributions, or a 12-database store's 60,000 with
// suggest's facts on 40,000 of them. A store larger than that says so (below)
// rather than thrashing silently, and the next step is the control plane.
const CEILING_SHARE = 0.1;
const MIB = 1024 * 1024;
const MIN_CEILING_BYTES = 8 * MIB;
const MAX_CEILING_BYTES = 256 * MIB;

function defaultCeiling(): number {
  const limit = getHeapStatistics().heap_size_limit;
  return Math.min(
    MAX_CEILING_BYTES,
    Math.max(MIN_CEILING_BYTES, Math.round(limit * CEILING_SHARE)),
  );
}

let ceilingBytes = defaultCeiling();

// What one entry costs the heap, estimated from the measurement above and
// rounded up: a hash string, a shared table list, a flag and a map slot.
const ATTRIBUTION_BYTES = 256;

/** The estimated heap cost of one entry, facts included. */
export function entryBytes(entry: PlanAttribution): number {
  return ATTRIBUTION_BYTES + (entry.workload === undefined ? 0 : workloadBytes(entry.workload));
}

// Interned names and column lists are shared, so a shape costs its own object
// and its references, not its strings — constants are the one per-plan string.
function workloadBytes(workload: PlanWorkload): number {
  let bytes = 96;
  for (const shape of workload.shapes) {
    bytes += 112 + 40 * shape.sort.length;
    if (shape.constants !== undefined) {
      bytes += 64;
      for (const value of Object.values(shape.constants)) {
        bytes += 24 + (typeof value === "string" ? 16 + value.length : 0);
      }
    }
  }
  return bytes + 56 * workload.missing.length + 56 * workload.purges.length;
}

// `fingerprint/database`. The fingerprint is hex, so the separator cannot occur
// in it, and a database name may contain anything but is only ever the tail.
type CacheKey = string;

interface Held {
  readonly plans: Map<number, PlanAttribution>;
  readonly bytes: number;
}

// Insertion-ordered on purpose: a JS Map iterates in insertion order and
// re-setting a key moves it to the end, which is the whole of the LRU.
const stores = new Map<CacheKey, Held>();
let heldBytes = 0;

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

/** The process-wide store for one connection target. */
export function sharedAttributions(fingerprint: string): PlanAttributions {
  return {
    get: (database) => stores.get(`${fingerprint}/${database}`)?.plans,
    set: (database, attributed) => {
      const key = `${fingerprint}/${database}`;
      // Deleted before being set so the key moves to the end of the iteration
      // order: without it a database written every collect would keep its
      // original position and be evicted ahead of one nothing has touched.
      const previous = stores.get(key);
      if (previous !== undefined) {
        heldBytes -= previous.bytes;
        stores.delete(key);
      }
      let bytes = 0;
      for (const entry of attributed.values()) bytes += entryBytes(entry);
      stores.set(key, { plans: attributed, bytes });
      heldBytes += bytes;
      evictFor(key);
    },
  };
}

// Back under the ceiling, giving up as LITTLE as it takes (#588). It used to drop
// whole databases, least recently written first, and one database is thousands
// of plans: a store a few hundred over the line lost five thousand, re-shipped
// them on the next pass, went over again and dropped the next database — every
// pass shipping a database's worth of XML. Plans are now dropped from the front
// of the least recently written database, oldest first, so going over by a few
// hundred costs a few hundred.
//
// A trimmed database is a COPY: the map being trimmed may be one a pass is in the
// middle of reading (`get` hands out the stored map), and it keeps its whole view.
// Never the key just written, however large it is — dropping the answer being
// used would make the ceiling a loop.
function evictFor(written: CacheKey): void {
  if (heldBytes <= ceilingBytes) return;
  let dropped = 0;
  for (const [key, held] of stores) {
    if (heldBytes <= ceilingBytes) break;
    if (key === written) continue;
    const excess = heldBytes - ceilingBytes;
    if (held.bytes <= excess) {
      stores.delete(key);
      heldBytes -= held.bytes;
      dropped += held.plans.size;
      continue;
    }
    const kept = new Map<number, PlanAttribution>();
    let freed = 0;
    let keptBytes = 0;
    for (const [planId, entry] of held.plans) {
      const size = entryBytes(entry);
      if (freed < excess) {
        freed += size;
        dropped += 1;
        continue;
      }
      kept.set(planId, entry);
      keptBytes += size;
    }
    // Same key, so the same place in the order: trimmed is not "touched".
    stores.set(key, { plans: kept, bytes: keptBytes });
    heldBytes -= held.bytes - keptBytes;
  }
  if (dropped > 0) warnEvicted(dropped);
}

// Said, because a store that does not fit is the failure #588 was, and it was
// silent: the only trace was a pass shipping XML it had shipped an hour before.
// At most once a minute, with what was dropped since the last line — a store
// that does not fit drops plans on every chunk it ships.
const WARN_EVERY_MS = 60_000;
let droppedSinceWarned = 0;
let lastWarnedAt = Number.NEGATIVE_INFINITY;

function warnEvicted(dropped: number): void {
  droppedSinceWarned += dropped;
  const now = Date.now();
  if (now - lastWarnedAt < WARN_EVERY_MS) return;
  lastWarnedAt = now;
  console.warn(
    `mssql plan cache: dropped ${droppedSinceWarned} plan(s) to stay under ` +
      `${(ceilingBytes / MIB).toFixed(1)} MiB (holding ${attributionsHeld()} plans, ` +
      `${(heldBytes / MIB).toFixed(1)} MiB) — a store this cannot hold re-ships its plans' XML ` +
      `on every pass; give the api more memory, or see D146`,
  );
  droppedSinceWarned = 0;
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
  heldBytes = 0;
  droppedSinceWarned = 0;
  lastWarnedAt = Number.NEGATIVE_INFINITY;
}

/** How many plans are held, for a test that asserts the ceiling holds. */
export function attributionsHeld(): number {
  let held = 0;
  for (const store of stores.values()) held += store.plans.size;
  return held;
}

/** The estimated bytes held, against the ceiling. */
export function attributionBytesHeld(): number {
  return heldBytes;
}

/** Set the ceiling, or restore the heap-sized one. Tests only. */
export function setAttributionCeilingForTests(bytes: number | null): void {
  ceilingBytes = bytes ?? defaultCeiling();
}
