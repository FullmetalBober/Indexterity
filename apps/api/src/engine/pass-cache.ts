import { AsyncLocalStorage } from "node:async_hooks";

// What a pass has already read from a customer's cluster, so that two callers
// wanting the same reading cost one round trip.
//
// The case it exists for: `$collStats: { storageStats: {} }` is one document
// with two projections nobody wants together — `size`/`count` feed the
// collection-size gates, `indexSizes` feeds the build estimate — and a suggest
// pass asks for both over the same namespace, in different loops either side of
// the workload read (jobs/suggest.ts). Read straight through that is a second
// full WiredTiger stats block per namespace per pass, a document that grows
// with the collection's index count and with nothing the pass is asking about.
//
// Scoped to a PASS, not to a session and not to a clock. The session is pooled
// (jobs/connection-pool.ts: shared across jobs, swept after five idle minutes),
// so a cache keyed to it would hand one hour's byte counts to the next hour's
// collect; a TTL would be a number standing in for a boundary that already
// exists. `runClusterTask` opens one of these per pass per cluster and drops it
// when the pass ends, which is exactly the interval over which a reading is
// allowed to stand in for itself.
//
// Carried by AsyncLocalStorage for the same reason `InFlight` is: the code that
// ISSUES a read and the code that decides a pass is over are many calls apart,
// and the engine-neutral ports between them have no business carrying a cache.
// No context — a controller calling a collector directly, a test — means no
// caching and every call reads, which is the behaviour that predates this.
//
// What may go in: a reading whose value is allowed to be as old as the pass.
// Storage statistics qualify — every consumer is a threshold, and the byte
// counts that are stored are only ever as fresh as the hourly collect storing
// them. A reading a later step could CHANGE does not qualify: an index's spec
// after a build, a counter the pass itself moved.
export class PassCache {
  // The promise, not the value, so two callers arriving together share one
  // round trip rather than racing to start two.
  private readonly entries = new Map<string, Promise<unknown>>();

  /**
   * The reading for `key`, taken once. A FAILED read is not a reading and is
   * evicted: cached, one unreachable moment would answer for the rest of the
   * pass, and callers are written to survive a throw rather than a pass of them.
   */
  // Declared as an overload rather than asserted inside. The body is honestly
  // `unknown -> unknown` — a map cannot remember which T each key was written
  // with — and only the signature knows that a key's reading comes back as
  // whatever its loader produced. Two callers giving one key different types is
  // a bug in the key, and no cast here could have caught it either.
  read<T>(key: string, load: () => Promise<T>): Promise<T>;
  read(key: string, load: () => Promise<unknown>): Promise<unknown> {
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const read = load();
    this.entries.set(key, read);
    read.catch(() => {
      if (this.entries.get(key) === read) this.entries.delete(key);
    });
    return read;
  }

  get size(): number {
    return this.entries.size;
  }
}

const passes = new AsyncLocalStorage<PassCache>();

/** Run a pass so that reads inside it share `cache`. */
export function withPassCache<T>(cache: PassCache, run: () => Promise<T>): Promise<T> {
  return passes.run(cache, run);
}

/**
 * Take a reading once per pass. Outside a pass there is nothing to share it
 * with, so the loader runs and nothing is kept.
 */
export function passCached<T>(key: string, load: () => Promise<T>): Promise<T>;
export function passCached(key: string, load: () => Promise<unknown>): Promise<unknown> {
  const store = passes.getStore();
  return store === undefined ? load() : store.read(key, load);
}
