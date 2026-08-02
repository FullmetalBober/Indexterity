import { type Plan, planFrom } from "../billing/plans";
import { clusters, type Database, eq, organizations } from "../db";

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
