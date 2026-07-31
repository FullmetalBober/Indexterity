import type { UsageClass } from "@repo/contracts";
import type { UsageSnapshot } from "./types";

export interface ClassifyOptions {
  // How many trailing snapshots define "recent" when deciding alive vs dead.
  readonly recentWindow: number;
  // Minimum snapshots required before attempting periodic classification.
  readonly minHistory: number;
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
// only counts when we were actually watching: too few snapshots, a hole in the
// series, or counters that restarted underneath us, and a busy index looks
// identical to a dead one. Structural findings (redundancy) do not depend on
// this.
export function usageHistoryIsTrustworthy(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
  now: Date,
): boolean {
  if (countersRestartedDuring(history)) return false;
  if (history.length < options.minHistory) return false;
  const times = history
    .map((snapshot) => new Date(snapshot.capturedAt).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  if (times.length < options.minHistory) return false;
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
