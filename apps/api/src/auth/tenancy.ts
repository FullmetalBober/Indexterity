import { defaultOrgPlan } from "../billing/plans";
import { and, asc, clusters, type Database, desc, eq, members, organizations, sql } from "../db";

export interface Membership {
  readonly orgId: string;
  readonly role: string;
}

// The caller's active membership: the switched-to one (is_active), else the
// oldest (deterministic when a user belongs to several orgs). Created lazily on
// first authenticated use so a fresh account always has somewhere to put its
// clusters. The creator is owner.
export async function resolveMembership(db: Database, userId: string): Promise<Membership> {
  const [membership] = await db
    .select({ orgId: members.orgId, role: members.role })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(desc(members.isActive), asc(members.createdAt))
    .limit(1);
  if (membership !== undefined) return membership;
  const [org] = await db
    .insert(organizations)
    .values({ name: "My Org", plan: defaultOrgPlan() })
    .returning({ id: organizations.id });
  if (org === undefined) throw new Error("failed to create organization");
  await db.insert(members).values({ orgId: org.id, userId, role: "owner" });
  return { orgId: org.id, role: "owner" };
}

export async function resolveOrgId(db: Database, userId: string): Promise<string> {
  return (await resolveMembership(db, userId)).orgId;
}

// Join an org from an invite. If the caller's only org is the empty auto-created
// shell (no clusters, sole member), it is dropped so the invited org becomes the
// active one; otherwise the membership is added alongside (oldest stays active).
export async function acceptOrgInvite(
  db: Database,
  userId: string,
  orgId: string,
  role: string,
): Promise<"joined" | "already-member"> {
  const [existing] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.orgId, orgId)))
    .limit(1);
  if (existing !== undefined) return "already-member";

  const mine = await db.select().from(members).where(eq(members.userId, userId));
  const only = mine.length === 1 ? mine[0] : undefined;
  if (only !== undefined) {
    const [clusterCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(clusters)
      .where(eq(clusters.orgId, only.orgId));
    const shellMembers = await db.select().from(members).where(eq(members.orgId, only.orgId));
    if ((clusterCount?.n ?? 0) === 0 && shellMembers.length === 1) {
      // Cascade removes the shell membership too.
      await db.delete(organizations).where(eq(organizations.id, only.orgId));
    }
  }
  await db.insert(members).values({ orgId, userId, role });
  return "joined";
}
