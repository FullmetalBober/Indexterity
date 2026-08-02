import type { UsageClass } from "@repo/contracts";
import type { UsageSnapshot } from "./types";

export interface ClassifyOptions {
  // How many trailing snapshots define "recent" when deciding alive vs dead.
  readonly recentWindow: number;
  // Minimum snapshots required before attempting periodic classification.
  readonly minHistory: number;
  // Minimum span the history must cover before absence of usage counts as
  // evidence. Snapshot count alone is not enough: three collects is eighteen
  // hours at the 6h cadence, and plenty of real work runs less often than that.
  readonly minHistoryDays: number;
  // Minimum intervals in which the COLLECTION actually served reads. Elapsed
  // time is the wrong clock for a cluster that is up continuously but only
  // worked occasionally — see analysis/activity.ts.
  readonly minActiveIntervals: number;
  // Largest acceptable hole between consecutive snapshots. A longer one means
  // we stopped watching (cluster unreachable, control plane down), so the
  // history cannot prove absence of usage.
  readonly maxGapHours: number;
}

const HOUR_MS = 3_600_000;

function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

// Did any member's $indexStats counter restart inside this history? The
// counter resets to zero when mongod restarts or the index is rebuilt, and
// `accesses.since` jumps forward to mark it. Two ways to notice:
//
//   1. `since` advanced for a member between two snapshots, or
//   2. the newest counters are YOUNGER than the window being judged — i.e.
//      they cannot possibly account for the whole period we are claiming was
//      idle (architecture §6.2).
//
// Snapshots collected before `since` was persisted carry none, and are simply
// skipped: no evidence either way, and the irreversible step downstream is
// still guarded by the regression gate.
export function countersRestartedDuring(history: readonly UsageSnapshot[]): boolean {
  const sorted = [...history].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return false;

  const earliestSince = new Map<string, number>();
  for (const snapshot of sorted) {
    for (const member of snapshot.perMember) {
      const since = parseTime(member.since);
      if (since === null) continue;
      const previous = earliestSince.get(member.member);
      if (previous === undefined) earliestSince.set(member.member, since);
      else if (since > previous) return true;
    }
  }

  const spanMs = new Date(last.capturedAt).getTime() - new Date(first.capturedAt).getTime();
  const lastCapturedAt = new Date(last.capturedAt).getTime();
  for (const member of last.perMember) {
    const since = parseTime(member.since);
    if (since === null) continue;
    if (lastCapturedAt - since < spanMs) return true;
  }
  return false;
}

// Is this history good enough to claim an index is UNUSED? Absence of evidence
// only counts when we were actually watching: too few snapshots, too short a
// span, a hole in the series, or counters that restarted underneath us, and a
// busy index looks identical to a dead one. Structural findings (redundancy) do
// not depend on this.
//
// The span requirement is the warm-up. A freshly connected cluster reaches
// three snapshots in eighteen hours, at which point every index that has not
// happened to run in those eighteen hours reads as dead — including the weekly
// batch and the quarterly export. Counting snapshots measures how often we
// looked; only the span measures how long we watched.
export function usageHistoryIsTrustworthy(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
  now: Date,
  // How many intervals the collection was actually queried in. Omitted by
  // callers with no latency history; the check is then skipped rather than
  // failing closed, since older data has no way to supply it.
  collectionActiveIntervals?: number,
): boolean {
  if (countersRestartedDuring(history)) return false;
  if (history.length < options.minHistory) return false;
  const times = history
    .map((snapshot) => new Date(snapshot.capturedAt).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  if (times.length < options.minHistory) return false;
  const oldest = times[0];
  const newestSeen = times.at(-1);
  if (oldest === undefined || newestSeen === undefined) return false;
  if (newestSeen - oldest < options.minHistoryDays * 24 * HOUR_MS) return false;
  // "This index served none of the reads" is only a claim when there were reads
  // to serve. An idle week proves nothing about any index in it.
  if (
    collectionActiveIntervals !== undefined &&
    collectionActiveIntervals < options.minActiveIntervals
  ) {
    return false;
  }
  const maxGap = options.maxGapHours * HOUR_MS;
  for (let i = 1; i < times.length; i++) {
    const previous = times[i - 1];
    const next = times[i];
    if (previous === undefined || next === undefined) continue;
    if (next - previous > maxGap) return false;
  }
  // The newest snapshot must itself be recent, or we are reasoning about a
  // cluster we have not seen in a while.
  const newest = times.at(-1);
  return newest !== undefined && now.getTime() - newest <= maxGap;
}

// Sum per-member ops for a snapshot (aggregate across all replica-set members).
export function totalOps(snapshot: UsageSnapshot): number {
  return snapshot.perMember.reduce((sum, member) => sum + member.ops, 0);
}

// Classify an index from its usage history. Pure; no I/O.
// PERIODIC_DEAD vs PERIODIC_ALIVE hinges on whether recent expected bursts
// still appear — a decommissioned monthly job goes dead and becomes droppable.
export function classifyUsage(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
): UsageClass {
  if (history.length < options.minHistory) return "FLAT_ZERO";

  const totals = history.map(totalOps);
  const activeCount = totals.filter((ops) => ops > 0).length;
  if (activeCount === 0) return "FLAT_ZERO";
  if (activeCount === totals.length) return "CONTINUOUS";

  const recent = totals.slice(-options.recentWindow);
  const recentlyActive = recent.some((ops) => ops > 0);
  return recentlyActive ? "PERIODIC_ALIVE" : "PERIODIC_DEAD";
}
