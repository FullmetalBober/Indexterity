import { inferChangeWindow, type TrafficSample } from "../analysis";
import { and, type Database, eq, gte, latencySamples, policies, sql } from "../db";
import { workloadKey } from "../engine/ports";
import { historyWindow } from "./plan";

// How much history the inference reads. See the comment on the query below.
const INFERENCE_WINDOW_DAYS = 30;

// Refresh the engine-chosen change window from this cluster's own traffic.
//
// The samples are per collection; the window is a property of the cluster, so the
// per-namespace rates are summed once each has been reduced on its own timeline.
// Runs after every collect — the window tracks a workload that shifts (a launch in
// a new region, a batch job moved) instead of being decided once at onboarding.
//
// Returns the window it stored, or null when the evidence did not support one.
export async function refreshInferredWindow(
  db: Database,
  clusterId: string,
): Promise<{ startHour: number; endHour: number } | null> {
  // Bounded, because this no longer aggregates in SQL. The old query grouped by
  // captured_at and summed, so it returned one row per collect however long the
  // history was; a per-namespace read returns one row per namespace per run, which
  // on a 200-collection cluster at a year's retention is two orders of magnitude
  // more. A month is well past what the inference can use — it needs three clean
  // intervals per 6h slot, about three days — and it keeps the window tracking a
  // workload that shifts rather than averaging in traffic patterns from last
  // summer. A run that started before the cutoff and is still live has a recent
  // last_seen_at, so it is still included, span and all.
  // The later of the two bounds: the inference's own month, and whatever the plan
  // is entitled to see. Normally the month wins — no plan retains less than that —
  // but an operator who set RETENTION_DAYS lower must not have the window inferred
  // from history nobody is allowed to read.
  const entitled = await historyWindow(db, clusterId);
  const cutoff = new Date(
    Math.max(Date.now() - INFERENCE_WINDOW_DAYS * 86_400_000, entitled.getTime()),
  );
  const rows = await db
    .select({
      database: latencySamples.database,
      collection: latencySamples.collection,
      capturedAt: latencySamples.capturedAt,
      lastSeenAt: latencySamples.lastSeenAt,
      observations: latencySamples.observations,
      ops: sql<number>`${latencySamples.readOps} + ${latencySamples.writeOps}`,
    })
    .from(latencySamples)
    .where(and(eq(latencySamples.clusterId, clusterId), gte(latencySamples.lastSeenAt, cutoff)));

  // Grouped per namespace, not summed per capture, and that is forced rather
  // than preferred. This used to `group by captured_at` and sum, which recovered
  // the cluster's total at an instant because every row of a collect shared that
  // instant. Runs end where each collection's own traffic changes, so the
  // timestamps no longer line up: a namespace whose run had not ended yet
  // contributes no row at the boundary, and the summed total would collapse and
  // recover at every one of them. inferChangeWindow reduces each namespace on its
  // own timeline and sums the rates at the end, where they are comparable.
  const byNamespace = new Map<string, TrafficSample[]>();
  for (const row of rows) {
    const key = workloadKey(row.database, row.collection);
    const series = byNamespace.get(key) ?? [];
    series.push({
      capturedAt: row.capturedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      observations: row.observations,
      ops: Number(row.ops),
    });
    byNamespace.set(key, series);
  }
  const inferred = inferChangeWindow([...byNamespace.values()]);

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
