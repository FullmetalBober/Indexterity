import { effectiveRetentionDays, type Plan, planFrom } from "../billing/plans";
import { clusters, type Database, eq, organizations } from "../db";

const DAY_MS = 86_400_000;

// The plan a cluster's owning org is on.
//
// The jobs need this as well as the api: a policy saved while an org was on PRO
// keeps its auto-approve score after a downgrade, and an entitlement checked
// only at save time would keep acting on it. The api decides what may be
// stored; this is how the engine decides what to obey.
export async function planForCluster(db: Database, clusterId: string): Promise<Plan> {
  const [row] = await db
    .select({ plan: organizations.plan })
    .from(clusters)
    .innerJoin(organizations, eq(clusters.orgId, organizations.id))
    .where(eq(clusters.id, clusterId))
    .limit(1);
  return planFrom(row?.plan);
}

// The oldest history this cluster is entitled to, as a cutoff to filter reads by.
//
// Rows now outlive the window they are visible in — deletion runs one uniform
// cutoff for the whole deployment (billing/plans.ts → maxRetentionDays) while what
// a plan may SEE is enforced here, on the way out. Every read of index_snapshots
// and latency_samples that reasons about HISTORY goes through this, engine and api
// alike: a longer series is what lets the engine call an index unused, so leaving
// the filter off the engine would quietly hand a free org paid-tier analysis.
//
// Filter on last_seen_at, never captured_at. A run that began before the cutoff
// and is still being extended is the CURRENT state of a live index; excluding it
// would hide the present because the past is out of view, which is the same
// mistake that made retention delete live rows.
//
// Reads that only ever want the newest row — the collector's own run lookup, the
// five-minute probe, the collection footprint, cluster freshness — do not need it:
// the newest row is inside every window by definition, and a plan cannot be
// entitled to less than "what is true now".
export async function historyWindow(db: Database, clusterId: string): Promise<Date> {
  const days = effectiveRetentionDays(await planForCluster(db, clusterId));
  if (!Number.isFinite(days)) return new Date(0);
  return new Date(Date.now() - days * DAY_MS);
}
