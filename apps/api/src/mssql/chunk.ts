// Why the two Query Store passes stop to breathe (#230).
//
// Both plan parsers — shapesFromPlans in ./workload.ts and
// deletePatternsFromPlans in ./delete-patterns.ts — are flat loops over up to
// MAX_PLANS_PER_DATABASE (5,000) showplan documents, and they run in the
// process that is also serving HTTP. Measured on plans shaped like the ones
// captured off a live 2022 CU26 (~2.4 KB each, MissingIndexes plus a sort plus
// a predicate), 5,000 of them parse in ~1.66 s, and run in one synchronous
// stretch that is 1652 ms during which a timer due every 10 ms does not fire —
// which is literally what an incoming request waits.
//
// Yielding every 100 rows takes the worst stall to 28 ms and costs nothing
// measurable: the chunked arm totalled 1587 ms against the sync arm's 1662 ms
// and a repeat sync arm's 1763 ms, so the totals are run-to-run spread rather
// than a speedup either way. Chunking every 500 rows still stalled for 147 ms,
// and every 25 rows shaved only another 16 ms off it, so 100 is where the curve
// flattens. ~50 setImmediate hops per database is nothing against 1.6 s of
// parsing.
//
// This buys interleaving, not throughput. The CPU a suggest pass costs is
// unchanged — it simply stops being 1.6 s in which nothing else is answered.
export const PLAN_PARSE_CHUNK = 100;

// setImmediate, not a resolved promise and not setTimeout(0). A microtask
// drains before the loop polls for I/O at all, so awaiting one yields nothing
// to a waiting socket; setImmediate runs in the check phase, after the poll, so
// the reads and request callbacks that arrived during the last chunk are served
// before the next chunk starts, and it does not wait on the timer heap.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
