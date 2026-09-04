import { AsyncLocalStorage } from "node:async_hooks";

// What a pass still has running on a customer's cluster, so that abandoning the
// pass can abandon those too (#454).
//
// A pass budget (`withPassBudget`) only stops AWAITING: the statement it was
// waiting on keeps running on the server and keeps its pooled socket until the
// driver's own request timeout, which on SQL Server is fifteen minutes. Measured
// on the production deploy, the Prod MSSQL collect ran past its five-minute
// budget, its two whole-Query-Store scans per table went on running, the next
// pass found all four sockets busy, and tarn — the pool under the driver — gave
// up on the acquire after its default 30 s with "operation timed out for an
// unknown reason". Cancelling what an abandoned pass left behind is what keeps
// the budget honest about "nothing was left running".
//
// Carried by AsyncLocalStorage rather than threaded through the ports, because
// the code that ISSUES a statement (a driver connection) and the code that
// decides a pass is over (`runClusterTask`) are twelve calls apart and the
// engine-neutral ports between them have no business knowing about sockets. A
// driver registers a way to cancel each statement while it runs; whoever runs
// the pass abandons them all when the pass ends badly. No context (a controller
// calling a collector directly, a test) means nothing is tracked and nothing
// changes — `trackInFlight` is a no-op then, on purpose.
export class InFlight {
  private readonly cancels = new Set<() => void>();

  /** Register a way to cancel one statement; returns the un-register. */
  track(cancel: () => void): () => void {
    this.cancels.add(cancel);
    return () => {
      this.cancels.delete(cancel);
    };
  }

  /**
   * Cancel everything still registered. Returns how many there were, for the log
   * line — a pass that left work behind is worth knowing about even after it is
   * cleaned up. A cancel that itself throws must not stop the others: each is
   * best-effort and the statement it targets may already have finished.
   */
  abandon(): number {
    const pending = [...this.cancels];
    this.cancels.clear();
    for (const cancel of pending) {
      try {
        cancel();
      } catch {
        // The statement is being thrown away either way.
      }
    }
    return pending.length;
  }

  get size(): number {
    return this.cancels.size;
  }
}

const passes = new AsyncLocalStorage<InFlight>();

/** Run a pass so that every statement issued inside it registers with `inFlight`. */
export function withInFlight<T>(inFlight: InFlight, run: () => Promise<T>): Promise<T> {
  return passes.run(inFlight, run);
}

/**
 * Register a statement with whatever pass is running, if one is. Called by a
 * driver connection around each statement; the returned function un-registers it
 * once the statement has settled.
 */
export function trackInFlight(cancel: () => void): () => void {
  const store = passes.getStore();
  return store === undefined ? () => undefined : store.track(cancel);
}
