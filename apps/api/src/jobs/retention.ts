import { makeWorkerUtils } from "graphile-worker";
import { effectiveRetentionDays, type Plan, planFrom } from "../billing/plans";
import { coreEnv, operatorCeilingDays } from "../config/env";
import {
  and,
  clusterIndexes,
  clusterNamespaces,
  clusters,
  type Database,
  eq,
  inArray,
  indexSnapshots,
  latencySamples,
  lt,
  organizations,
  recommendations,
  session,
  sql,
  verification,
  workloadShapes,
} from "../db";

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
export async function pruneDeadLetterJobs(db: Database): Promise<number> {
  const rows = await db.execute(sql`
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

// Expired auth rows, which nothing was deleting.
//
// `session` grows with every sign-in — the table's own comment in db/schema.ts
// says so — and `verification` with every emailed link. Neither is per-cluster
// or per-plan, so neither belongs to any of the windows below: they belong to
// the deployment, like the dead letters above, and the rule is simply that an
// expired row is expired. Measured on the hosted deployment, two of four session
// rows were already past `expires_at` with nothing that would ever remove them.
//
// better-auth prunes its rate-limit counters on write and its own tables it does
// not, which is defensible for an auth library — a session row is the only record
// of a sign-in and deleting it is the application's call, not the library's.
// This is the application making it.
//
// No grace period. A row past `expires_at` is one better-auth will never accept
// again, so deleting it changes an expired session into an absent one, and both
// are the same 401. A window would only be a number standing in for a doubt.
export async function pruneExpiredAuthRows(db: Database): Promise<number> {
  const now = new Date();
  const sessions = await db
    .delete(session)
    .where(lt(session.expiresAt, now))
    .returning({ id: session.id });
  const verifications = await db
    .delete(verification)
    .where(lt(verification.expiresAt, now))
    .returning({ id: verification.id });
  return sessions.length + verifications.length;
}

// How long the time-series tables are KEPT: each cluster's own plan window,
// capped by the operator's RETENTION_DAYS (#549, D172).
//
// It used to be one cutoff for the whole deployment, the longest window any plan
// may see, with each org's own window applied on the way out (jobs/plan.ts →
// historyWindow). That bought two things. An upgrade returned the customer's
// history at once, because the rows had been there all along out of view. And
// deletion was one sweep over one time range. What it cost was storage nobody
// could read: on a deployment whose orgs are FREE and PRO, everything past 183
// days (half of what the 365-day sweep kept) was history no reader was
// entitled to. On a small database that is the fastest way to its storage limit;
// on Neon Free, 0.5 GB is about a hundred days of this fleet's history.
//
// So a row goes when its plan says it goes. What that gives up, stated:
//
//   An upgrade starts from what the old plan kept. A FREE org moving to PRO has
//   its 90 days, and the rest of the new window fills as time passes.
//
//   A downgrade deletes, at the next sweep, what the new plan cannot see, and
//   nothing brings it back. set-plan.ts says so when it moves an org down.
//
// The read-side window stays where it is. Between two sweeps a row can be up to
// a day past its plan's window, and the plan must not see it in that day either.
// History depth is still the entitlement, because a longer series is what lets
// the engine call an index unused at all, so the read filter still covers the
// engine's reads as well as the dashboard's.
export async function pruneOldSamples(db: Database): Promise<number> {
  const owned = await db
    .select({ clusterId: clusters.id, plan: organizations.plan })
    .from(clusters)
    .innerJoin(organizations, eq(clusters.orgId, organizations.id));
  // A deployment with no clusters still signs people in, so the auth sweep is on
  // both paths out of here rather than only the one that had work to do.
  if (owned.length === 0) {
    return (await pruneDeadLetterJobs(db)) + (await pruneExpiredAuthRows(db));
  }

  // One pass per plan rather than per cluster: every cluster on a plan shares its
  // cutoff, so the statements stay a handful however large the fleet grows.
  const byPlan = new Map<Plan, string[]>();
  for (const row of owned) {
    const plan = planFrom(row.plan);
    const ids = byPlan.get(plan) ?? [];
    ids.push(row.clusterId);
    byPlan.set(plan, ids);
  }
  let pruned = 0;
  for (const [plan, clusterIds] of byPlan) {
    const days = effectiveRetentionDays(plan, operatorCeilingDays());
    if (!Number.isFinite(days)) continue;
    const cutoff = new Date(Date.now() - days * DAY_MS);
    pruned += await pruneHistory(db, clusterIds, cutoff);
    pruned += await pruneDecisions(db, clusterIds, cutoff);
  }
  return pruned + (await pruneDeadLetterJobs(db)) + (await pruneExpiredAuthRows(db));
}

// The time series and what hangs off them, for clusters that share one cutoff.
async function pruneHistory(db: Database, clusterIds: string[], cutoff: Date): Promise<number> {
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
  // The namespaces the latency deletion stranded (#551), on the rule the index
  // dimension just followed and for the same two reasons. Nothing cascades this
  // way, and a collect writes the namespace before the sample that points at it,
  // so only a namespace older than the cutoff AND unreferenced can go.
  const namespaces = await db
    .delete(clusterNamespaces)
    .where(
      and(
        inArray(clusterNamespaces.clusterId, clusterIds),
        lt(clusterNamespaces.createdAt, cutoff),
        sql`not exists (select 1 from ${latencySamples} where ${latencySamples.namespaceId} = ${clusterNamespaces.id})`,
      ),
    )
    .returning({ id: clusterNamespaces.id });
  // Scanning query shapes (#432). By `last_seen_at` for the same reason the
  // two series above are: the row is a standing statement — first seen then,
  // still true at last_seen_at — so a shape the workload still runs is not
  // aged out however long ago it started. What ages out is a shape that
  // stopped scanning before the cutoff, which is either an index somebody
  // built or a query somebody deleted, and in both cases the finding is gone.
  const shapes = await db
    .delete(workloadShapes)
    .where(
      and(inArray(workloadShapes.clusterId, clusterIds), lt(workloadShapes.lastSeenAt, cutoff)),
    )
    .returning({ id: workloadShapes.id });
  return samples.length + snapshots.length + dimensions.length + namespaces.length + shapes.length;
}

// Finished decisions, on the same clock as the history they were made from.
//
// Only terminal states. Everything else describes something still live — an
// index waiting out its observe window, a build the engine is still watching —
// and its row is the only record that it is in flight.
//
// Actions cascade with their recommendation, so the audit trail and the
// rollback token go with it. Undo therefore stops being offered once a drop
// passes the window, which is the same promise the plan already makes.
async function pruneDecisions(db: Database, clusterIds: string[], cutoff: Date): Promise<number> {
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
  return decisions.length;
}
