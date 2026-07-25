import { type Database, eq, members, organizations } from "../db";

// The caller's org. One org per user for now, created lazily on first
// authenticated use so a fresh account always has somewhere to put its clusters.
export async function resolveOrgId(db: Database, userId: string): Promise<string> {
  const [membership] = await db
    .select({ orgId: members.orgId })
    .from(members)
    .where(eq(members.userId, userId))
    .limit(1);
  if (membership !== undefined) return membership.orgId;
  const [org] = await db
    .insert(organizations)
    .values({ name: "My Org" })
    .returning({ id: organizations.id });
  if (org === undefined) throw new Error("failed to create organization");
  await db.insert(members).values({ orgId: org.id, userId, role: "owner" });
  return org.id;
}
