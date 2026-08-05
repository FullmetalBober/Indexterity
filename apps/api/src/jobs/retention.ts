import { makeWorkerUtils } from "graphile-worker";
import { entitlementsFor, type Plan, planFrom } from "../billing/plans";
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
import { requiredEnv } from "../env";
import { jobDb } from "./db";

const DAY_MS = 86_400_000;
// One batch per run. A backlog drains over consecutive days rather than holding
// a transaction open over a hundred thousand rows.
const MAX_DEAD_LETTERS_PER_RUN = 5000;

// RETENTION_DAYS is the operator's ceiling, not the plan's number. Storage is
// the operator's bill, so they can cap it; a plan may keep less than the cap but
// never more. Unset means the plan decides on its own.
function operatorCeilingDays(): number {
  const envDays = Number(process.env.RETENTION_DAYS);
  return Number.isFinite(envDays) && envDays > 0 ? envDays : Number.POSITIVE_INFINITY;
}

export function effectiveRetentionDays(plan: Plan): number {
  return Math.min(entitlementsFor(plan).retentionDays, operatorCeilingDays());
}

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
  const utils = await makeWorkerUtils({ connectionString: requiredEnv("DATABASE_URL") });
  try {
    await utils.completeJobs(ids);
  } finally {
    await utils.release();
  }
  return ids.length;
}

// Time-series tables grow on every collect, forever, and how long they are kept
// is an entitlement: longer history is what makes a usage claim trustworthy
// (analysis/classify.ts refuses to call an index dead without one), so it is
// worth paying for and has to be enforced rather than merely advertised.
//
// Grouped by plan rather than pruned per cluster: one delete per distinct plan
// instead of one per cluster, and every org on the same plan shares a cutoff.
export async function pruneOldSamples(): Promise<number> {
  const db = jobDb();
  const owned = await db
    .select({ clusterId: clusters.id, plan: organizations.plan })
    .from(clusters)
    .innerJoin(organizations, eq(clusters.orgId, organizations.id));

  const byPlan = new Map<Plan, string[]>();
  for (const row of owned) {
    const plan = planFrom(row.plan);
    const ids = byPlan.get(plan) ?? [];
    ids.push(row.clusterId);
    byPlan.set(plan, ids);
  }

  let pruned = 0;
  for (const [plan, clusterIds] of byPlan) {
    const days = effectiveRetentionDays(plan);
    if (!Number.isFinite(days)) continue;
    const cutoff = new Date(Date.now() - days * DAY_MS);
    // By when a run ENDED, not when it started. A row covers
    // [captured_at, last_seen_at], so pruning on the start would delete the run
    // an idle index is still living in the moment it grew older than the window —
    // taking with it the only record that we are watching that index at all, and
    // handing the trust gate a hole where there was none. What ages out is a
    // stretch of history that finished before the cutoff, which is what the plan
    // actually promises to forget.
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
    // Finished decisions age out on the same clock. Retention used to cover the
    // two tables of raw counters and leave the two a customer actually reads —
    // so a plan sold as "90 days of history" kept every recommendation and
    // every audit line forever. That is both more data than the plan promises
    // and more than is useful: a recommendation that was dropped, rejected or
    // rolled back last year answers no question anyone asks.
    //
    // Only terminal states. Everything else describes something still live —
    // an index waiting out its observe window, a build the engine is still
    // watching — and its row is the only record that it is in flight.
    //
    // Actions cascade with their recommendation, so the audit trail and the
    // rollback token go with it. Undo therefore stops being offered once a drop
    // passes the window, which is the same promise the plan already makes.
    const decisions = await db
      .delete(recommendations)
      .where(
        and(
          inArray(recommendations.clusterId, clusterIds),
          inArray(recommendations.state, ["DROPPED", "REJECTED", "ROLLED_BACK"]),
          lt(recommendations.updatedAt, cutoff),
        ),
      )
      .returning({ id: recommendations.id });
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
    pruned += samples.length + snapshots.length + decisions.length + dimensions.length;
  }
  return pruned + (await pruneDeadLetterJobs());
}
