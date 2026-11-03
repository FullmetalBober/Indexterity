// Stretches when Indexterity itself was not running (#653), and what they cost
// the analysis.
//
// A stored series has holes for two reasons that look identical in it: the
// cluster was quiet, or we were not there to read it. Counters that kept running
// through a hole of ours still difference correctly — but the longer the hole,
// the likelier a reset inside it that nothing dated, and a latency counter carries
// no start stamp to date one. A window across our own outage is therefore not
// trusted as observation, and the time it covered is not charged to the drop
// either: the observe deadline moves out by exactly that much.

// A gap between two stretches of ticks longer than this is an outage of ours. The
// tick reaches the database every FAST_PASS_INTERVAL_MINUTES (an hour at most),
// so this is the slowest cadence and one tick it may miss.
export const OWN_OUTAGE_MS = 2 * 3_600_000;

// [fromMs, toMs): the last tick before the outage, and the first after it.
export interface OwnOutage {
  readonly fromMs: number;
  readonly toMs: number;
}

// The gaps between stretches of ticks, wider than OWN_OUTAGE_MS. `runs` in any
// order, each [since, lastSeen].
export function outagesBetween(
  runs: readonly { readonly sinceMs: number; readonly lastSeenMs: number }[],
): OwnOutage[] {
  const sorted = [...runs].sort((a, b) => a.sinceMs - b.sinceMs);
  const outages: OwnOutage[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const next = sorted[i];
    if (previous === undefined || next === undefined) continue;
    if (next.sinceMs - previous.lastSeenMs > OWN_OUTAGE_MS) {
      outages.push({ fromMs: previous.lastSeenMs, toMs: next.sinceMs });
    }
  }
  return outages;
}

// Whether [startMs, endMs] overlaps any outage of ours.
export function spansOwnOutage(
  outages: readonly OwnOutage[],
  startMs: number,
  endMs: number,
): boolean {
  return outages.some((outage) => startMs < outage.toMs && endMs > outage.fromMs);
}

// How much of [startMs, endMs] we were not running for.
export function ownOutageMs(outages: readonly OwnOutage[], startMs: number, endMs: number): number {
  return outages.reduce(
    (sum, outage) =>
      sum + Math.max(0, Math.min(endMs, outage.toMs) - Math.max(startMs, outage.fromMs)),
    0,
  );
}
