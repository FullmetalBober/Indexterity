import type { BlockedReason } from "@repo/contracts";
import { and, clusterBlocks, type Database, eq, sql } from "../db";

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
//
// ONE ROW PER PASS since #462, and the grain is the whole of that change — see
// `clusterBlocks` in db/schema.ts for what sharing one slot cost.

/**
 * Record why one pass stopped, and when it started failing this way.
 *
 * One statement, no read, because `since` has to answer "for how long" without a
 * race between two passes landing at once: the CASE keeps the existing timestamp
 * while the reason is unchanged, and starts a new one when the reason itself
 * changes — a cluster that was unreachable and is now refusing TLS is a new
 * condition, not a continuation of the old one.
 *
 * Keyed on (cluster, task), so a `probe` that has been timing out for an hour and
 * a `collect` that has been unreachable since Tuesday are two facts and the
 * dashboard can say both. Before this they were one column and the later pass
 * won.
 */
export async function markBlocked(
  db: Database,
  clusterId: string,
  task: string,
  reason: BlockedReason,
  detail: string,
): Promise<void> {
  await db
    .insert(clusterBlocks)
    .values({ clusterId, task, reason, detail })
    .onConflictDoUpdate({
      target: [clusterBlocks.clusterId, clusterBlocks.task],
      set: {
        reason,
        detail,
        since: sql`case when ${clusterBlocks.reason} = ${reason} then ${clusterBlocks.since} else now() end`,
      },
    });
}

/**
 * Clear it for the pass that got through, and for that pass only.
 *
 * The `task` argument is the fix, not a refinement of it. This used to clear
 * every column unconditionally on any pass that finished, so the five-minute
 * `probe` erased a `collect` that had been failing for 19 hours and the cluster
 * rendered as healthy — the state #462 was opened for. A pass can only speak for
 * itself: reaching the end of `probe` is evidence about `probe`.
 *
 * A DELETE rather than nulled columns, because absence is what "this pass is
 * fine" means here, and it keeps the ordinary case — six passes per cluster per
 * tick, times the fleet, all of them fine — a delete that matches nothing rather
 * than an update writing the same nulls over and over and waking every replica
 * for it.
 */
export async function markUnblocked(db: Database, clusterId: string, task: string): Promise<void> {
  await db
    .delete(clusterBlocks)
    .where(and(eq(clusterBlocks.clusterId, clusterId), eq(clusterBlocks.task, task)));
}
