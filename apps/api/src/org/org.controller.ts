import { Controller, Req } from "@nestjs/common";
import { implement } from "@orpc/nest";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { requireSession } from "../auth/session";
import { resolveMembership } from "../auth/tenancy";
import { defaultOrgPlan, entitlementsFor, planFrom } from "../billing/plans";
import { orgsHeldBy } from "../billing/usage";
import { provisionedUsersIn } from "../clusters/offboard";
import { and, asc, clusters, eq, gt, invites, members, organizations, user } from "../db";
import { DatabaseService } from "../db/database.service";
import { Implement } from "../orpc/implement";

// The org reads better-auth's organization plugin cannot answer.
//
// It used to be nine routes. Seven of them changed an org — rename, role,
// remove, leave, switch, invite, accept — and every one of those is now a plugin
// endpoint under /api/auth/organization/*, including the last-owner rules we had
// written twice with two different error messages.
//
// What is left is what the plugin has no opinion about: the plan and how much of
// it is spent, and the caller's role in each of their orgs, which
// `organization.list` does not return. Both are reads, and both answer for a
// caller who belongs to no organization at all — a state that exists now that
// orgs are made on purpose rather than conjured by the first GET.
@Controller()
export class OrgController {
  constructor(private readonly database: DatabaseService) {}

  // Infinity does not survive JSON, so an absent limit is null.
  private static cap(value: number): number | null {
    return Number.isFinite(value) ? value : null;
  }

  @Implement(contract.getOrg)
  getOrg(@Req() req: FastifyRequest) {
    return implement(contract.getOrg).handler(async () => {
      const session = await requireSession(req);
      const membership = await resolveMembership(
        this.database.db,
        session.userId,
        session.activeOrgId,
      );
      // Not an error: the dashboard draws a create-org screen for it, and a 404
      // would make the shell's three reads look like a broken api.
      if (membership === null) return null;
      const orgId = membership.orgId;

      const [org] = await this.database.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (org === undefined) return null;

      const [memberRows, clusterRows, pending, provisionedUsers, held] = await Promise.all([
        this.database.db
          .select({
            memberId: members.id,
            userId: members.userId,
            role: members.role,
            email: user.email,
            name: user.name,
          })
          .from(members)
          .innerJoin(user, eq(members.userId, user.id))
          .where(eq(members.orgId, orgId)),
        this.database.db
          .select({ id: clusters.id })
          .from(clusters)
          .where(eq(clusters.orgId, orgId)),
        this.database.db
          .select()
          .from(invites)
          .where(
            and(
              eq(invites.orgId, orgId),
              eq(invites.status, "pending"),
              gt(invites.expiresAt, new Date()),
            ),
          ),
        provisionedUsersIn(this.database.db, orgId),
        orgsHeldBy(this.database.db, session.userId),
      ]);

      const plan = planFrom(org.plan);
      const limits = entitlementsFor(plan);
      return {
        id: orgId,
        name: org.name,
        slug: org.slug,
        role: membership.role,
        plan: {
          plan,
          maxClusters: OrgController.cap(limits.maxClusters),
          maxMembers: OrgController.cap(limits.maxMembers),
          workloadAnalysis: limits.workloadAnalysis,
          autoApply: limits.autoApply,
          clustersUsed: clusterRows.length,
          // Seats are members plus outstanding invites — the same count the
          // limit is enforced on, so the number on screen matches the refusal.
          membersUsed: memberRows.length + pending.length,
          // Counted against the plan a NEW org would land on, not this org's,
          // because that is the plan the create gate reads.
          maxOrgs: OrgController.cap(entitlementsFor(defaultOrgPlan()).maxOrgs),
          orgsUsed: held,
        },
        members: memberRows,
        pendingInvites: pending.map((invite) => ({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
        })),
        provisionedUsers,
      };
    });
  }

  @Implement(contract.listOrgs)
  listOrgs(@Req() req: FastifyRequest) {
    return implement(contract.listOrgs).handler(async () => {
      const session = await requireSession(req);
      const active = await resolveMembership(this.database.db, session.userId, session.activeOrgId);
      const rows = await this.database.db
        .select({
          orgId: members.orgId,
          role: members.role,
          createdAt: members.createdAt,
          name: organizations.name,
        })
        .from(members)
        .innerJoin(organizations, eq(members.orgId, organizations.id))
        .where(eq(members.userId, session.userId))
        .orderBy(asc(members.createdAt));
      return rows.map((row) => ({
        orgId: row.orgId,
        name: row.name,
        role: row.role,
        active: row.orgId === active?.orgId,
      }));
    });
  }

  @Implement(contract.listMyInvites)
  listMyInvites(@Req() req: FastifyRequest) {
    return implement(contract.listMyInvites).handler(async () => {
      const session = await requireSession(req);
      const [me] = await this.database.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, session.userId))
        .limit(1);
      if (me === undefined) return [];
      const rows = await this.database.db
        .select({
          id: invites.id,
          role: invites.role,
          expiresAt: invites.expiresAt,
          orgName: organizations.name,
        })
        .from(invites)
        .innerJoin(organizations, eq(invites.orgId, organizations.id))
        .where(
          and(
            // The plugin lowercases the address it stores; user.email is stored
            // as typed, so this is compared the same way the accept endpoint
            // compares it rather than a way that happens to work today.
            eq(invites.email, me.email.toLowerCase()),
            eq(invites.status, "pending"),
            gt(invites.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(invites.createdAt));
      return rows.map((row) => ({
        id: row.id,
        orgName: row.orgName,
        role: row.role,
        expiresAt: row.expiresAt.toISOString(),
      }));
    });
  }
}
