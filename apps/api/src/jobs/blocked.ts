import type { BlockedReason } from "@repo/contracts";
import { and, clusters, type Database, eq, isNotNull, sql } from "../db";

// Why a cluster's pipeline is not running, kept where a screen can read it.
//
// `runClusterTask` has always known: it records a metric, logs a line and mails
// the owners once a day. None of that reaches somebody who opens the dashboard a
// week later, so a cluster nobody could reach showed up as `lastCollectedAt`
// going stale — and staleness has innocent causes. The condition was diagnosed
// and then thrown away, which is the failure shape that reads as "all is well".
//
// The vocabulary is the metric's, deliberately: one set of names for what the
// pipeline can be stopped by, so an operator reading a gauge and an owner reading
// a badge are looking at the same fact.

// The reasons themselves live in @repo/contracts, with the screen that labels
// them: one list, so a gauge and a badge cannot disagree about what stopped.

/**
 * Record why the pipeline stopped, and when it started stopping.
 *
 * One statement, no read, because `blocked_since` has to answer "for how long"
 * without a race between two passes landing at once: the CASE keeps the existing
 * timestamp while the reason is unchanged, and starts a new one when the reason
 * itself changes — a cluster that was unreachable and is now refusing TLS is a
 * new condition, not a continuation of the old one.
 */
export async function markBlocked(
  db: Database,
  clusterId: string,
  reason: BlockedReason,
  detail: string,
): Promise<void> {
  await db
    .update(clusters)
    .set({
      blockedReason: reason,
      blockedDetail: detail,
      blockedSince: sql`case when ${clusters.blockedReason} = ${reason} then coalesce(${clusters.blockedSince}, now()) else now() end`,
    })
    .where(eq(clusters.id, clusterId));
}

/**
 * Clear it, on any pass that got through.
 *
 * Guarded on there being something to clear, so the ordinary case — six passes
 * per cluster per tick, times the fleet, all of them fine — is a SELECT that
 * matches nothing rather than an UPDATE that writes the same three nulls over
 * and over and wakes every replica for it.
 */
export async function markUnblocked(db: Database, clusterId: string): Promise<void> {
  await db
    .update(clusters)
    .set({ blockedReason: null, blockedSince: null, blockedDetail: null })
    .where(and(eq(clusters.id, clusterId), isNotNull(clusters.blockedReason)));
}
