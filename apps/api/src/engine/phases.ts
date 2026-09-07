import { AsyncLocalStorage } from "node:async_hooks";

// Where a pass spent its time, so that abandoning one can say what it was doing
// (#466).
//
// A budget rejects with "ran past its 5 minutes budget and was abandoned", and
// until now that was the whole of what anybody got: the block, the owner's mail
// and the log line all carried the same sentence, and none of them said which
// part of the pass was slow. That cost a release. #461 cut the SQL Server
// collect from ~1,100 statements to ~78 — measured on a live server as zero
// per-table catalog calls — and the tunnelled production cluster still timed
// out, with nothing to read but the same sentence. The fleet's own comparison
// then showed the remaining cost is not round trips at all: the direct MSSQL
// cluster of nearly the same size (12 databases, 334 tables) collects every
// tick, so what differs is the tunnel and not the statement count.
//
// Carried by AsyncLocalStorage for the reason InFlight is (./inflight.ts): the
// code that SPENDS the time is a driver read, the code that decides the pass is
// over is `runClusterTask`, and the engine-neutral ports between them have no
// business carrying a stopwatch. No context — a controller calling a collector
// directly, a unit test — means nothing is timed and nothing changes, which is
// what makes `timePhase` safe to put anywhere.
//
// Wall clock, deliberately, and not CPU: what is being diagnosed is a link, and
// a phase that is entirely waiting on a socket is exactly the phase worth
// naming.

/** One phase's total, across however many times the pass entered it. */
export interface Phase {
  readonly name: string;
  readonly totalMs: number;
  readonly calls: number;
  // Entered and not yet left when the report was taken. NOT an error case and
  // not a rare one: a budget abandons the pass mid-flight, so the phase that was
  // running when the clock ran out is the single most useful line in the report
  // — and it is by definition unfinished. Counting only completed phases would
  // have left the loop that was actually slow out of every report.
  readonly running: boolean;
}

export class PassPhases {
  // Aggregated by NAME rather than per call, because the report has to fit in a
  // sentence a person reads in an email. Thirteen `latencyByCollection` calls
  // are one fact — "this phase cost 241s over 13 calls" — and thirteen lines of
  // per-database timings would bury it.
  private readonly totals = new Map<string, { totalMs: number; calls: number }>();
  // Start times of phases still open, per name. A list rather than one stamp
  // because nothing stops two calls of the same phase overlapping inside a
  // `Promise.all`, and taking only the latest would under-report the pair.
  private readonly open = new Map<string, number[]>();

  /**
   * Start a phase; the returned function ends it.
   *
   * Split rather than taking a callback so a caller can time something that is
   * not shaped like one call — the per-collection loop in collectSnapshots is
   * one phase over hundreds of iterations.
   */
  enter(name: string): () => void {
    const started = Date.now();
    const starts = this.open.get(name) ?? [];
    starts.push(started);
    this.open.set(name, starts);
    let ended = false;
    return () => {
      // Idempotent: a caller that ends a phase in a `finally` a throw can reach
      // twice would otherwise count it twice, and a phase counted twice is a
      // wrong number reported with total confidence.
      if (ended) return;
      ended = true;
      const remaining = this.open.get(name) ?? [];
      const at = remaining.indexOf(started);
      if (at !== -1) remaining.splice(at, 1);
      if (remaining.length === 0) this.open.delete(name);
      else this.open.set(name, remaining);
      const found = this.totals.get(name) ?? { totalMs: 0, calls: 0 };
      found.totalMs += Date.now() - started;
      found.calls += 1;
      this.totals.set(name, found);
    };
  }

  /**
   * Every phase entered, most expensive first, counting time already spent in
   * phases that have not finished.
   *
   * `now` is a parameter so a test can assert an elapsed figure without waiting
   * for one — the alternative is fake timers around AsyncLocalStorage, which is
   * a lot of machinery to check an addition.
   */
  phases(now: number = Date.now()): Phase[] {
    const merged = new Map<string, { totalMs: number; calls: number; running: boolean }>();
    for (const [name, { totalMs, calls }] of this.totals) {
      merged.set(name, { totalMs, calls, running: false });
    }
    for (const [name, starts] of this.open) {
      const found = merged.get(name) ?? { totalMs: 0, calls: 0, running: false };
      for (const started of starts) found.totalMs += now - started;
      merged.set(name, {
        totalMs: found.totalMs,
        // Counted, so "1 call that has not returned" is distinguishable from
        // "362 that did". Both are things a reader acts on differently.
        calls: found.calls + starts.length,
        running: true,
      });
    }
    return [...merged]
      .map(([name, phase]) => ({ name, ...phase }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /**
   * The breakdown as one clause, or the empty string when nothing was timed.
   *
   * Empty rather than "no phases recorded", because the caller appends this to a
   * sentence: a pass abandoned before it entered any phase, or one on an engine
   * with no instrumentation yet, should read exactly as it did before this
   * existed rather than gaining a clause saying nothing.
   *
   * Capped at `top`, since the point is which phase dominated and an operator
   * reading a mail does not need the tail. Sub-second phases are dropped for the
   * same reason — on a pass that spent five minutes they are noise, and rounding
   * them to `0s` invites reading them as measured zeros.
   */
  summary(top = 4, now: number = Date.now()): string {
    const worth = this.phases(now).filter((phase) => phase.totalMs >= 1_000);
    if (worth.length === 0) return "";
    return worth
      .slice(0, top)
      .map((phase) => {
        const spent = `${phase.name} ${Math.round(phase.totalMs / 1_000)}s/${phase.calls}`;
        // Said in words rather than punctuated, because this clause is read by
        // whoever runs the deployment in an email, and "still running" is the
        // half that tells them the number is a floor and not a total.
        return phase.running ? `${spent} (still running)` : spent;
      })
      .join(", ");
  }
}

const passes = new AsyncLocalStorage<PassPhases>();

/** Run a pass so that everything inside it times its phases into `phases`. */
export function withPhases<T>(phases: PassPhases, run: () => Promise<T>): Promise<T> {
  return passes.run(phases, run);
}

/**
 * Time one phase of whatever pass is running, if one is.
 *
 * Ends the phase on both paths: a phase that threw still cost what it cost, and
 * a read that fails slowly is precisely the thing worth seeing in the breakdown.
 */
export async function timePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const store = passes.getStore();
  if (store === undefined) return run();
  const done = store.enter(name);
  try {
    return await run();
  } finally {
    done();
  }
}

/**
 * The same, for a phase that is not one call — a loop, or a span the caller ends
 * itself. Returns a no-op when no pass is running, so the caller needs no branch.
 */
export function beginPhase(name: string): () => void {
  const store = passes.getStore();
  return store === undefined ? () => undefined : store.enter(name);
}
