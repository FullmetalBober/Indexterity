import { and, clusterPassTimings, type Database, eq, inArray } from "../db";
import type { ClusterTaskOutcome } from "../metrics";

// Pacing a cluster whose collect does not fit (#571, D179).
//
// A collect that needs longer than CLUSTER_PASS_BUDGET_MS used to be abandoned
// every hour, forever: the same five minutes against the same cluster, the same
// TIMED_OUT block, nothing collected, and the owner mailed about it once a day.
// The budget is five minutes because the worker has ONE slot and the schedule
// ticks every five, so a pass longer than that keeps every other cluster's probe
// and apply waiting behind it — raising the budget for everybody to fit the
// slowest cluster would spend the fleet's slot on one cluster's link.
//
// So the slow cluster is given longer AND asked less often, by the same factor.
// At tier k its collect gets 2^k budgets every 2^k hours, so the share of the
// slot it may take never moves: five minutes an hour is ten every two is twenty
// every four. What changes is only that the twenty minutes can finish.
//
// Capped at tier 2 — four hours — and the cap is the analysis's, not the
// scheduler's. The change window is inferred in six-hour slots, and an interval
// longer than a slot leaves slots that no reading's gap ever starts in. And the
// queue alert (prometheusrule.yaml) fires on a job waiting fifteen minutes for
// ten: a twenty-minute collect holding the slot clears it, and a forty-minute
// one would not.

/** The furthest a collect is paced: every four hours, with four budgets. */
export const MAX_COLLECT_TIER = 2;

// A collect that LANDED above this share of its budget is stepped up anyway. It
// fitted, barely, and the next slower hour is the one it does not — so it is
// given room before it starts failing rather than after.
export const STEP_UP_SHARE = 0.75;

// A paced collect steps back down once it fits in this share of the tier
// below's budget. Half, rather than the step-up line, so a collect that sits
// near a boundary does not flap between two tiers on alternate runs: stepping
// down to a budget it would use three quarters of is the step back up waiting.
export const STEP_DOWN_SHARE = 0.5;

const HOUR_MS = 3_600_000;

function clamped(tier: number): number {
  if (!Number.isFinite(tier)) return 0;
  return Math.min(MAX_COLLECT_TIER, Math.max(0, Math.trunc(tier)));
}

/** The wall clock a collect at `tier` runs against. */
export function collectBudgetMs(tier: number, baseMs: number): number {
  return baseMs * 2 ** clamped(tier);
}

/** How many hours apart a collect at `tier` runs. */
export function collectEveryHours(tier: number): number {
  return 2 ** clamped(tier);
}

/**
 * The tier the NEXT collect gets, from how this one went at `tier`.
 *
 * Only a timeout or a landed collect is evidence about the length of the work.
 * An unreachable cluster, a tunnel that is down, unreadable credentials, a
 * refused version — none of those say anything about how long a collect takes,
 * so they leave the tier where it was rather than pacing a cluster for being
 * down.
 */
export function nextCollectTier(
  tier: number,
  outcome: ClusterTaskOutcome,
  durationMs: number,
  baseMs: number,
): number {
  const current = clamped(tier);
  if (outcome === "timed-out") return clamped(current + 1);
  if (outcome !== "ok") return current;
  if (durationMs >= STEP_UP_SHARE * collectBudgetMs(current, baseMs)) return clamped(current + 1);
  if (current > 0 && durationMs <= STEP_DOWN_SHARE * collectBudgetMs(current - 1, baseMs)) {
    return current - 1;
  }
  return current;
}

/**
 * Whether a cluster's collect is due at `now`, which the hourly dispatcher asks.
 *
 * Counted in whole hours of the schedule, not in elapsed time since the last
 * collect started. A collect starts minutes after the hour it was dispatched
 * on — later when the queue is busy — so "two hours since it started" would
 * miss the occurrence it was meant for by a few minutes and run three hours
 * apart. Flooring both instants to their hour measures the schedule instead.
 *
 * An unpaced cluster is always due, which is exactly the hourly schedule as it
 * was. So is a cluster with no recorded collect, which has not been paced yet.
 */
export function collectIsDue(tier: number, lastStartedAt: Date | null, now: Date): boolean {
  const current = clamped(tier);
  if (current === 0 || lastStartedAt === null) return true;
  const hours = Math.floor(now.getTime() / HOUR_MS) - Math.floor(lastStartedAt.getTime() / HOUR_MS);
  return hours >= collectEveryHours(current);
}

/** Where one cluster's collect stands: its tier, and when it last started. */
export interface CollectPace {
  readonly tier: number;
  readonly lastStartedAt: Date | null;
}

const UNPACED: CollectPace = { tier: 0, lastStartedAt: null };

/** The pace of one cluster's collect, for the collect that is about to run. */
export async function collectPaceOf(db: Database, clusterId: string): Promise<CollectPace> {
  const [row] = await db
    .select({ tier: clusterPassTimings.tier, startedAt: clusterPassTimings.startedAt })
    .from(clusterPassTimings)
    .where(and(eq(clusterPassTimings.clusterId, clusterId), eq(clusterPassTimings.task, "collect")))
    .limit(1);
  return row === undefined ? UNPACED : { tier: row.tier, lastStartedAt: row.startedAt };
}

/**
 * Which of `clusterIds` have a collect due at `now` — one read for the fleet,
 * like the dispatcher's own running-pass read.
 */
export async function collectsDue(
  db: Database,
  clusterIds: readonly string[],
  now: Date,
): Promise<ReadonlySet<string>> {
  if (clusterIds.length === 0) return new Set();
  const rows = await db
    .select({
      clusterId: clusterPassTimings.clusterId,
      tier: clusterPassTimings.tier,
      startedAt: clusterPassTimings.startedAt,
    })
    .from(clusterPassTimings)
    .where(
      and(
        eq(clusterPassTimings.task, "collect"),
        inArray(clusterPassTimings.clusterId, [...clusterIds]),
      ),
    );
  const pace = new Map(rows.map((row) => [row.clusterId, row]));
  const due = new Set<string>();
  for (const id of clusterIds) {
    const found = pace.get(id);
    if (found === undefined || collectIsDue(found.tier, found.startedAt, now)) due.add(id);
  }
  return due;
}
