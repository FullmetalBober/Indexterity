import { and, asc, type Database, eq, members } from "../db";

export interface Membership {
  readonly orgId: string;
  readonly role: string;
}

// The caller's active membership, or null when they are in no organization at
// all — which is now a state the product has, and did not before.
//
// It used to create one. The first authenticated request from a fresh account
// inserted an org called "My Org" and made the caller its owner, which meant an
// organization was something that happened TO you: a name nobody chose and
// everybody kept, appearing as a side effect of a GET. Creating one is a verb
// now (better-auth's `organization.create`), so this only resolves.
//
// The switcher's selection lives on the SESSION rather than on the user, so two
// browsers can sit in two different orgs. An activeOrganizationId that names an
// org the caller is no longer a member of — removed while signed in, or the org
// deleted — is ignored rather than obeyed, and falls through to the same
// deterministic default as a session that never switched: the oldest membership.
export async function resolveMembership(
  db: Database,
  userId: string,
  activeOrgId: string | null,
): Promise<Membership | null> {
  if (activeOrgId !== null) {
    const [chosen] = await db
      .select({ orgId: members.orgId, role: members.role })
      .from(members)
      .where(and(eq(members.userId, userId), eq(members.orgId, activeOrgId)))
      .limit(1);
    if (chosen !== undefined) return chosen;
  }
  const [oldest] = await db
    .select({ orgId: members.orgId, role: members.role })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return oldest ?? null;
}
