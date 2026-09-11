import { createHash } from "node:crypto";
import type { ServerVersion } from "./version";

// How many of a collection's reads were OURS.
//
// `$collStats: { latencyStats: {} }` reports every read the collection served,
// and the metadata reads this product issues to measure it are reads. Measured
// on mongod 8.0, one call each, against a collection with three indexes:
//
//   | call                        | latencyStats.reads | any index's accesses.ops |
//   |-----------------------------|--------------------|--------------------------|
//   | `$collStats storageStats`   | +2                 | 0                        |
//   | `$collStats latencyStats`   | +1                 | 0                        |
//   | `$indexStats`               | +1                 | 0                        |
//   | `listIndexes`               | 0 (a command)      | 0                        |
//   | `find` served by an index   | +1                 | +1                       |
//
// So a collect pass leaves a floor under every namespace it looks at, whether
// or not anyone queried it. On the hosted deployment's dev cluster that floor
// was exactly 8 reads an hour on all 102 namespaces — four from collect and four
// from suggest, the latter now two since #500 gave the two storageStats
// projections one read — with a measured MINIMUM across the cluster of 8.0 and
// not one namespace ever reading zero. `analysis/activity.ts` credits an interval as
// active whenever the counter moved, so it moved on every interval for every
// collection, `collection-idle` became unreachable on MongoDB, and idleness
// started funding the drops it exists to withhold. The control group is SQL
// Server, which reads DMVs and never touches the tables: 382 idle refusals
// there against zero across 128 MongoDB indexes.
//
// The fix is to subtract what we know we issued, which means counting it.
//
// WHY NOT A FLOOR. A constant would be a number that stops being true the next
// time a pass gains or loses a call — silently, and in the drop-happy
// direction. A tally moves with the code that causes it, and a new call site
// declares its own cost at the point it pays it.
//
// WHY THE COUNTER IS CUMULATIVE, and what happens when it is not. The analysis
// differences two samples, so what it needs is our count at each of them; a
// count that resets — a redeployed worker, a second replica taking the next
// pass — makes ONE interval's subtraction negative, and `foldActivity` drops a
// negative interval as unknowable exactly as it already drops a mongod counter
// restart. That is the safe direction: an interval nobody can account for buys
// no active time, and buying none only ever withholds a drop.
//
// WHY THE PASS BOUNDARY DOES NOT MATTER. A sample is taken part-way through a
// pass, so an interval between two samples holds the tail of one pass, whatever
// ran between them, and the head of the next. The tally is read once per pass,
// after it — so the interval's subtraction holds the WHOLE of the later pass
// and none of the earlier one. Those are equal as long as each pass issues the
// same calls per namespace, which is what makes the intra-pass ordering (a
// `Promise.all` over five reads) irrelevant rather than a race to lose.

// Per-call cost, from the table above. Named at the call site rather than
// summed here, so a reader of the collector sees what a call costs where it is
// made and a new one cannot be added without answering the question.
export const READS_PER_COLL_STATS_STORAGE = 2;
export const READS_PER_COLL_STATS_LATENCY = 1;

// `$indexStats` IS NOT A CONSTANT ACROSS SERVER VERSIONS, and finding that out
// cost a shipped bug. Measured on three servers, same probe, same collection:
//
//   | mongod | $indexStats | storageStats | latencyStats |
//   |--------|-------------|--------------|--------------|
//   | 6.0.28 |           2 |            2 |            1 |
//   | 7.0.39 |           1 |            2 |            1 |
//   | 8.2.9  |           1 |            2 |            1 |
//
// The original table was taken on 8.0 alone and hard-coded 1, so on a 6.0 server
// this product under-counts its own reads by one per namespace per pass. That is
// not a rounding error: `analysis/activity.ts` credits an interval as active
// when the adjusted delta is positive, and a permanent +1 makes every interval
// of every collection positive — which is the whole of #493, still happening on
// 6.0 after #493 shipped.
//
// UNKNOWN VERSIONS TAKE THE HIGHER NUMBER, deliberately. Over-counting our own
// reads subtracts too much, which withholds active time and therefore withholds
// drops; under-counting manufactures activity and allows them. Only one of those
// is survivable in a gate whose job is to refuse. The cost is that a server we
// cannot identify folds nothing, which is a saving rather than a safety.
export function readsPerIndexStats(version: ServerVersion | null): number {
  return version === null || version.major < 7 ? 2 : 1;
}

// A hard ceiling on namespaces held, for the same reason attributions.ts has
// one: nothing discards this for us. A key and a number is a few dozen bytes,
// so this is single-digit megabytes at the ceiling, and a deployment with more
// live namespaces than this has a bigger problem than an imprecise gate.
const MAX_NAMESPACES = 50_000;

const counts = new Map<string, number>();

/**
 * What the collector does with the tally, narrowed to the two operations it
 * makes.
 *
 * An interface rather than the module's functions, so a collector built outside
 * a session — `diagnose`, a test — gets a tally of its own and cannot reach
 * into a shared one, and so the tests need no global reset between cases.
 */
export interface SelfReads {
  /** Record that we issued `ops` reads' worth of work against one namespace. */
  add(database: string, collection: string, ops: number): void;
  /** How many we have issued against it since this tally started. */
  count(database: string, collection: string): number;
}

/**
 * The connection target's identity, hashed.
 *
 * The same argument as attributions.ts: keyed by what the pool already dooms an
 * entry on when credentials rotate, so one target keeps its tally and a rotated
 * string starts a new one — which is right, since the string may now reach a
 * different server whose counters mean something else. Hashed so a credential is
 * not also a map key held for the life of the process.
 */
export function connectionFingerprint(connString: string): string {
  return createHash("sha256").update(connString).digest("hex").slice(0, 32);
}

/** The process-wide tally for one connection target. */
export function sharedSelfReads(fingerprint: string): SelfReads {
  const keyFor = (database: string, collection: string): string =>
    `${fingerprint}/${database}/${collection}`;
  return {
    add: (database, collection, ops) => {
      const key = keyFor(database, collection);
      const held = counts.get(key) ?? 0;
      // Deleted before being set so the key moves to the end of the iteration
      // order, which is what makes the eviction below least-recently-written.
      counts.delete(key);
      counts.set(key, held + ops);
      for (const candidate of counts.keys()) {
        if (counts.size <= MAX_NAMESPACES) break;
        if (candidate === key) continue;
        counts.delete(candidate);
      }
    },
    count: (database, collection) => counts.get(keyFor(database, collection)) ?? 0,
  };
}

/** A tally belonging to one caller, for a collector that is not a session's. */
export function ownSelfReads(): SelfReads {
  const mine = new Map<string, number>();
  return {
    add: (database, collection, ops) => {
      const key = `${database}/${collection}`;
      mine.set(key, (mine.get(key) ?? 0) + ops);
    },
    count: (database, collection) => mine.get(`${database}/${collection}`) ?? 0,
  };
}

/** Forget everything. Tests only — nothing in the pipeline needs to. */
export function forgetSelfReads(): void {
  counts.clear();
}

/** How many namespaces are held, for a test that asserts the ceiling holds. */
export function selfReadsHeld(): number {
  return counts.size;
}
