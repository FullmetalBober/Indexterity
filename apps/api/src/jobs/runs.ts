import { MAX_GAP_MS } from "../analysis";

// Whether a collect extends the run already on the row or starts a new one.
//
// This is the whole of the run-length decision, kept pure and away from the
// database so the two rules that make it safe can be tested on their own:
//
//   1. The state has to be identical. Not "close enough" — a counter that moved
//      by one is a different state, and the row it belongs on is a new one.
//   2. The state has to still be in view. A run asserts that nothing changed
//      throughout [capturedAt, lastSeenAt], and the usage trust gate only looks
//      for holes BETWEEN runs, so extending across a week of silence would
//      dissolve the outage into a row that claims we were watching. Past the
//      analysis layer's own tolerance, an identical reading is a coincidence
//      rather than a continuation, and it gets its own row.
//
// Rule 2 is the one worth stating out loud, because omitting it fails silently
// and in the dangerous direction: the series looks unbroken, the gate finds
// nothing to object to, and a cluster nobody could reach for a fortnight ends up
// certifying that its indexes went unused.
export interface CurrentRun {
  readonly fingerprint: string;
  readonly lastSeenAt: Date;
}

export function extendsRun(
  current: CurrentRun | undefined,
  fingerprint: string,
  now: Date,
): boolean {
  if (current === undefined) return false;
  if (current.fingerprint !== fingerprint) return false;
  const sinceLastSeen = now.getTime() - current.lastSeenAt.getTime();
  // A reading stamped BEFORE the run's end cannot extend it — moving lastSeenAt
  // backwards would shorten the very interval it is meant to assert. Rare (a
  // clock stepping back over an api replica), and a new row is the reading that
  // is at least true of itself.
  if (sinceLastSeen < 0) return false;
  return sinceLastSeen <= MAX_GAP_MS;
}

// The identity of an index's counter state.
//
// Sorted by member, because $indexStats is gathered per replica-set member and
// nothing promises the order holds between two collects — an unsorted join would
// read a re-ordered response as a changed counter and write a row per collect
// forever, quietly undoing the whole point.
//
// `since` belongs in here as much as `ops` does: it is the counter's start, and
// a restart that happened to leave the same op count is emphatically not the
// same state.
export function counterFingerprint(
  perMember: readonly { member: string; ops: number; since?: string }[],
): string {
  return [...perMember]
    .sort((a, b) => a.member.localeCompare(b.member))
    .map((member) => `${member.member}\u0000${member.ops}\u0000${member.since ?? ""}`)
    .join("\u0001");
}

// The identity of a collection's latency state: the counters that move only when
// SOMEBODY ELSE touches the collection.
//
// It used to be all four raw counters, on the reasoning that every one of them
// is a measurement and none merely rides along. That was right about the
// measurements and wrong about the identity, and it cost the whole saving on the
// engine that writes most of these rows. `$collStats` counts the metadata reads
// this product issues to measure a collection (#493), so `readOps` and
// `readLatencyMicros` move on every collect whether or not a customer queried
// anything — and a state that never repeats folds nothing. Measured over sixteen
// days of production, `sum(observations) / count(*)` on `latency_samples`:
// **1.00x on both MongoDB clusters** against 16.3x and 181.5x on the two SQL
// Server ones, which read DMVs and never touch the tables.
//
// `readOps - selfReadOps` is the part nobody here caused. `writeOps` needs no
// adjustment: nothing this product does writes to a customer's collection.
//
// NEITHER LATENCY TOTAL IS IN HERE, and the two are dropped for different
// reasons. `writeLatencyMicros` is implied — write latency cannot move while
// `writeOps` stands still — so keeping it added nothing. `readLatencyMicros`
// moves with OUR reads and is the specific thing that made this never fold;
// subtracting it would need our own server-side microseconds, which mongod does
// not break out. So it leaves the identity and becomes what `size_bytes` already
// is in recordSnapshots: a measurement the run carries live, replaced on every
// extend rather than frozen at the run's start.
//
// That replacement is the load-bearing half. Left frozen, a long idle run would
// accumulate every one of our microseconds into a single difference, and the
// first real query afterwards would divide a run's worth of our overhead by a
// handful of real operations — an enormous µs/op reading manufactured out of
// idleness, which is a worse signal than the one this fixes. Replaced, every
// delta is measured across the SAME gap between two runs, which is also the
// interval `activeHours` credits.
export function latencyFingerprint(sample: {
  readOps: number;
  selfReadOps: number;
  writeOps: number;
}): string {
  return [sample.readOps - sample.selfReadOps, sample.writeOps].join("\u0000");
}
