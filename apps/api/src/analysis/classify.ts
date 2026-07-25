import type { UsageClass } from "@repo/contracts";
import type { UsageSnapshot } from "./types";

export interface ClassifyOptions {
  // How many trailing snapshots define "recent" when deciding alive vs dead.
  readonly recentWindow: number;
  // Minimum snapshots required before attempting periodic classification.
  readonly minHistory: number;
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
