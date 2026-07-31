import { inferChangeWindow, type TrafficSample } from "../analysis";
import { type Database, eq, latencySamples, policies, sql } from "../db";

// Refresh the engine-chosen change window from this cluster's own traffic.
//
// The samples are per collection; the window is a property of the cluster, so
// ops are summed per capture before the deltas are taken. Runs after every
// collect — the window tracks a workload that shifts (a launch in a new region,
// a batch job moved) instead of being decided once at onboarding.
//
// Returns the window it stored, or null when the evidence did not support one.
export async function refreshInferredWindow(
  db: Database,
  clusterId: string,
): Promise<{ startHour: number; endHour: number } | null> {
  const rows = await db
    .select({
      capturedAt: latencySamples.capturedAt,
      ops: sql<number>`sum(${latencySamples.readOps} + ${latencySamples.writeOps})`,
    })
    .from(latencySamples)
    .where(eq(latencySamples.clusterId, clusterId))
    .groupBy(latencySamples.capturedAt);

  const samples: TrafficSample[] = rows.map((row) => ({
    capturedAt: row.capturedAt.toISOString(),
    ops: Number(row.ops),
  }));
  const inferred = inferChangeWindow(samples);

  // Upsert, not update: a policies row only exists once an owner has saved
  // one, and the engine must still record its choice for every other cluster.
  // Written even when null — a cluster whose traffic flattened out should stop
  // advertising a window we no longer stand behind.
  const chosen = {
    inferredWindowStartHour: inferred?.startHour ?? null,
    inferredWindowEndHour: inferred?.endHour ?? null,
    inferredWindowReason: inferred?.reason ?? null,
  };
  await db
    .insert(policies)
    .values({ clusterId, ...chosen })
    .onConflictDoUpdate({ target: policies.clusterId, set: chosen });

  return inferred === null ? null : { startHour: inferred.startHour, endHour: inferred.endHour };
}

// The window that actually applies: an owner's explicit setting always wins,
// the engine's inference fills the gap, and only a cluster we have not watched
// long enough runs unrestricted.
export function effectiveChangeWindow(policy: {
  changeWindowStartHour: number | null;
  changeWindowEndHour: number | null;
  inferredWindowStartHour: number | null;
  inferredWindowEndHour: number | null;
}): { startHour: number | null; endHour: number | null } {
  if (policy.changeWindowStartHour !== null && policy.changeWindowEndHour !== null) {
    return { startHour: policy.changeWindowStartHour, endHour: policy.changeWindowEndHour };
  }
  return { startHour: policy.inferredWindowStartHour, endHour: policy.inferredWindowEndHour };
}
