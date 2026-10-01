import { clusterPassTimings, type Database, type PassPhaseRecord } from "../db";
import type { Phase } from "../engine/phases";
import type { ClusterTaskOutcome } from "../metrics/jobs";

// How long a pass last took against a cluster, kept where a screen can read it
// (#571).
//
// The same shape of fix as blocked.ts, for the half of the story blocked.ts
// cannot tell: a block says a pass stopped, and nothing said how close a pass
// that got through came to stopping. One row per pass, overwritten — see
// `clusterPassTimings` in db/schema.ts for why the last run and not a history.

/** What one run of a pass cost, as `runClusterTask` measured it. */
export interface PassTiming {
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly outcome: ClusterTaskOutcome;
  // The wall clock it ran against, or null for a pass that has none.
  readonly budgetMs: number | null;
  readonly phases: readonly Phase[];
}

// The phases kept with the row. The report a person reads stops at four (the
// alert mail's `summary`); the row keeps a few more, because a screen can lay
// out a list a sentence cannot, and the tail is still bounded so one pass that
// timed a hundred distinct phases cannot grow the row without limit.
const KEPT_PHASES = 8;

function nonNegative(ms: number): number {
  return Math.max(0, Math.round(ms));
}

/**
 * Record one run, replacing the pass's previous one.
 *
 * One statement and no read, like `markBlocked`: two runs of different passes
 * land on different rows, and two runs of the SAME pass cannot overlap, because
 * each pass has its own queue per cluster (dispatch.ts).
 */
export async function recordPassTiming(
  db: Database,
  clusterId: string,
  task: string,
  timing: PassTiming,
): Promise<void> {
  const row = {
    startedAt: timing.startedAt,
    // Clamped, because a wall clock can step backwards under a pass, and the
    // panel's contract refuses a negative duration — one bad sample would take
    // the whole read down with it rather than show a zero.
    durationMs: nonNegative(timing.durationMs),
    outcome: timing.outcome,
    budgetMs: timing.budgetMs,
    phases: timing.phases.slice(0, KEPT_PHASES).map(
      (phase): PassPhaseRecord => ({
        name: phase.name,
        totalMs: nonNegative(phase.totalMs),
        calls: phase.calls,
        running: phase.running,
      }),
    ),
  };
  await db
    .insert(clusterPassTimings)
    .values({ clusterId, task, ...row })
    .onConflictDoUpdate({
      target: [clusterPassTimings.clusterId, clusterPassTimings.task],
      set: row,
    });
}
