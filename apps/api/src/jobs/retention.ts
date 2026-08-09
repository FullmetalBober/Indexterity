import { makeWorkerUtils } from "graphile-worker";
import { effectiveRetentionDays, maxRetentionDays, type Plan, planFrom } from "../billing/plans";
import { coreEnv, operatorCeilingDays } from "../config/env";
import {
  and,
  clusterIndexes,
  clusters,
  eq,
  inArray,
  indexSnapshots,
  latencySamples,
  lt,
  organizations,
  recommendations,
  sql,
} from "../db";
import { jobDb } from "./db";

const DAY_MS = 86_400_000;
// One batch per run. A backlog drains over consecutive days rather than holding
// a transaction open over a hundred thousand rows.
const MAX_DEAD_LETTERS_PER_RUN = 5000;

// Dead letters are not per-org — they belong to the deployment, so they age out
// on the operator's window, or a generous default when there is none.
function deadLetterCutoff(): Date {
  const days = Number.isFinite(operatorCeilingDays()) ? operatorCeilingDays() : 90;
  return new Date(Date.now() - days * DAY_MS);
}

// A job that burns its last attempt keeps its row, as the record of what went
// wrong. Nothing ever removes it. A cluster unreachable for a week, or an
// offboarded one whose ticks were already queued, leaves rows in the
// control-plane database permanently — the same unbounded growth the
// time-series tables were pruned for, in the one table nobody was watching.
//
// Old failures are not diagnostics, they are debris: past the retention window
// nobody is going to read them. Removed on the same schedule and the same knob
// as everything else.
//
// `graphile_worker.jobs` is the public view; `_private_jobs` is private and its
// shape moves between releases. completeJobs() is the supported way to delete a
// job row, so the ids come from the view and the deletion goes through the API.
export async function pruneDeadLetterJobs(): Promise<number> {
  const rows = await jobDb().execute(sql`
    select id::text as id from graphile_worker.jobs
    where attempts >= max_attempts
      and locked_at is null
      and updated_at < ${deadLetterCutoff()}
    limit ${MAX_DEAD_LETTERS_PER_RUN}
  `);
  const ids = rows.rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
  if (ids.length === 0) return 0;
  const utils = await makeWorkerUtils({ connectionString: coreEnv().DATABASE_URL });
  try {
    await utils.completeJobs(ids);
  } finally {
    await utils.release();
  }
  return ids.length;
}

// How long the time-series tables are KEPT, which is no longer the same question
// as how much of them a customer may SEE.
//
// It used to be. Deletion ran a different cutoff per plan, so a FREE org's rows
// physically went at ninety days. That coupled two things that want different
// answers: deletion wants ONE boundary it can sweep in bulk, and entitlement wants
// a per-org boundary. Splitting them means deletion runs a single cutoff for the
// whole deployment — the longest any plan may see — and the plan's own window is
// applied on the way out instead (jobs/plan.ts → historyWindow, wired into every
// read of these tables).
//
// Three things fall out of that, all of them wanted:
//
//   An upgrade returns the customer's history at once. Before, a FREE org moving
//   to PRO got nothing extra until ninety more days had passed, because the rows
//   it was now entitled to had already been deleted.
//
//   Pruning becomes one bulk sweep over a contiguous time range rather than rows
//   scattered by tenant, which is the shape any partitioned or compressed store
//   wants and is cheaper on a plain heap too.
//
//   And it costs very little, because of run-length storage: an idle index is one
//   row whether it is retained for ninety days or a year. The extra rows are only
//   where the counters actually moved.
//
// What it does NOT mean is that a plan quietly gets more analysis than it pays
// for. History depth is the entitlement — a longer series is what lets the engine
// call an index unused at all — so the window is applied to the engine's reads as
// well as the dashboard's. Retained-but-invisible has to be invisible to
// classify.ts too, or the entitlement is advertised rather than enforced.
export async function pruneOldSamples(): Promise<number> {
  const db = jobDb();
  const owned = await db
    .select({ clusterId: clusters.id, plan: organizations.plan })
    .from(clusters)
    .innerJoin(organizations, eq(clusters.orgId, organizations.id));
  if (owned.length === 0) return await pruneDeadLetterJobs();
  const clusterIds = owned.map((row) => row.clusterId);

  let pruned = 0;
  const keepDays = maxRetentionDays(operatorCeilingDays());
  if (Number.isFinite(keepDays)) {
    const cutoff = new Date(Date.now() - keepDays * DAY_MS);
    // By when a run ENDED, not when it started. A row covers
    // [captured_at, last_seen_at], so pruning on the start would delete the run
    // an idle index is still living in the moment it grew older than the window —
    // taking with it the only record that we are watching that index at all, and
    // handing the trust gate a hole where there was none. What ages out is a
    // stretch of history that finished before the cutoff.
    const samples = await db
      .delete(latencySamples)
      .where(
        and(inArray(latencySamples.clusterId, clusterIds), lt(latencySamples.lastSeenAt, cutoff)),
      )
      .returning({ id: latencySamples.id });
    const snapshots = await db
      .delete(indexSnapshots)
      .where(
        and(inArray(indexSnapshots.clusterId, clusterIds), lt(indexSnapshots.lastSeenAt, cutoff)),
      )
      .returning({ id: indexSnapshots.id });
    // The dimension rows the deletions above just stranded. Nothing cascades
    // here — the foreign key runs the other way — so an index dropped from the
    // cluster a year ago would keep its spec forever, which is the leak this
    // table would introduce if it were only ever written to.
    //
    // Older than the cutoff AND unreferenced, not merely unreferenced. A collect
    // writes the dimension row before the snapshot that points at it, so a sweep
    // landing between the two would see a legitimate orphan and delete a row the
    // insert is about to reference. A row cannot be older than the retention
    // window and also seconds old, so the age test closes that window rather than
    // narrowing it.
    const dimensions = await db
      .delete(clusterIndexes)
      .where(
        and(
          inArray(clusterIndexes.clusterId, clusterIds),
          lt(clusterIndexes.createdAt, cutoff),
          sql`not exists (select 1 from ${indexSnapshots} where ${indexSnapshots.indexId} = ${clusterIndexes.id})`,
        ),
      )
      .returning({ id: clusterIndexes.id });
    pruned += samples.length + snapshots.length + dimensions.length;
  }

  // Finished decisions stay per-plan, and deliberately so. The visibility trick
  // above works because a counter reading is a fact that costs nothing to hold
  // back; a settled recommendation is a record about the customer's cluster, and
  // "we still have last year's decisions, we just do not show them to you" is a
  // promise nobody asked for. There is no bulk-sweep argument here either —
  // recommendations do not grow per collect. So this one still deletes on the
  // plan's own clock.
  //
  // Only terminal states. Everything else describes something still live — an
  // index waiting out its observe window, a build the engine is still watching —
  // and its row is the only record that it is in flight.
  //
  // Actions cascade with their recommendation, so the audit trail and the
  // rollback token go with it. Undo therefore stops being offered once a drop
  // passes the window, which is the same promise the plan already makes.
  const byPlan = new Map<Plan, string[]>();
  for (const row of owned) {
    const plan = planFrom(row.plan);
    const ids = byPlan.get(plan) ?? [];
    ids.push(row.clusterId);
    byPlan.set(plan, ids);
  }
  for (const [plan, ids] of byPlan) {
    const days = effectiveRetentionDays(plan, operatorCeilingDays());
    if (!Number.isFinite(days)) continue;
    const cutoff = new Date(Date.now() - days * DAY_MS);
    const decisions = await db
      .delete(recommendations)
      .where(
        and(
          inArray(recommendations.clusterId, ids),
          inArray(recommendations.state, ["DROPPED", "REJECTED", "ROLLED_BACK"]),
          lt(recommendations.updatedAt, cutoff),
        ),
      )
      .returning({ id: recommendations.id });
    pruned += decisions.length;
  }
  return pruned + (await pruneDeadLetterJobs());
}
