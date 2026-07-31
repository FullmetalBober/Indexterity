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

// Is this history good enough to claim an index is UNUSED? Absence of evidence
// only counts when we were actually watching: too few snapshots, or a hole in
// the series, and a busy index looks identical to a dead one. Structural
// findings (redundancy) do not depend on this.
export function usageHistoryIsTrustworthy(
  history: readonly UsageSnapshot[],
  options: ClassifyOptions,
  now: Date,
): boolean {
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
