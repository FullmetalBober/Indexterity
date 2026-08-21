import { Controller, Logger, Req } from "@nestjs/common";
import { contract, SECURITY_TRAIL_PAGE } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { actorFromRequest } from "../audit/http-actor";
import { recordSecurityEvent } from "../audit/security-events";
import { entitlementsFor, planFrom } from "../billing/plans";
import { orgPolicyFor } from "../clusters/least-privilege";
import { provisionedUsersIn } from "../clusters/offboard";
import {
  and,
  asc,
  clusters,
  desc,
  eq,
  gt,
  invites,
  members,
  organizations,
  orgPolicies,
  securityEvents,
  sql,
  user,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { TenancyService } from "../http/tenancy.service";
import { Implement, route } from "../orpc/implement";

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
  private readonly log = new Logger(OrgController.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
  ) {}

  // Infinity does not survive JSON, so an absent limit is null.
  private static cap(value: number): number | null {
    return Number.isFinite(value) ? value : null;
  }

  @Implement(contract.getOrg)
  getOrg(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getOrg, req, "session").handler(async ({ context }) => {
      // Not an error: the dashboard draws a create-org screen for it, and a 404
      // would make the shell's three reads look like a broken api.
      const membership = context.member;
      if (membership === null) return null;
      const orgId = membership.orgId;

      const [org] = await this.database.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (org === undefined) return null;

      const [memberRows, clusterRows, pending, provisionedUsers, policy] = await Promise.all([
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
        // On this payload rather than behind its own fetch (#313): the Settings
        // toggle that owns it and the connection card of every cluster both need
        // it, and a card that fetched one boolean per cluster would draw itself
        // before knowing whether the cluster it describes is out of policy.
        orgPolicyFor(this.database.db, orgId),
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
        },
        members: memberRows,
        pendingInvites: pending.map((invite) => ({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
        })),
        provisionedUsers,
        policy: {
          requireLeastPrivilege: policy.requireLeastPrivilege,
          updatedAt: policy.updatedAt?.toISOString() ?? null,
        },
      };
    });
  }

  // The org's policy on its own, for a caller that wants it without the member
  // list. Readable by any member: it is a rule that governs what THEY can do
  // when they connect a cluster, and a refusal whose reason a reader cannot look
  // up is a refusal they will read as a bug.
  @Implement(contract.getOrgPolicy)
  getOrgPolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getOrgPolicy, req, "member").handler(
      async ({ context }) => {
        const policy = await orgPolicyFor(this.database.db, context.member.orgId);
        return {
          requireLeastPrivilege: policy.requireLeastPrivilege,
          updatedAt: policy.updatedAt?.toISOString() ?? null,
        };
      },
    );
  }

  // Owner-only, and replaced whole the way the per-cluster knobs are.
  //
  // `owner` rather than `freshOwner`, which rotating and going live are on the
  // other side of. Those three change what the control plane HOLDS on somebody's
  // production database; this one changes what it will agree to hold NEXT time,
  // and it cannot loosen anything already stored — the clusters sealed under the
  // old rule keep running and are marked out of policy instead. Recorded in the
  // security trail either way, because turning it off is what lets the next
  // connect store an admin string.
  @Implement(contract.updateOrgPolicy)
  updateOrgPolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.updateOrgPolicy, req, "owner").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        const before = await orgPolicyFor(this.database.db, orgId);
        const [saved] = await this.database.db
          .insert(orgPolicies)
          .values({
            orgId,
            requireLeastPrivilege: input.requireLeastPrivilege,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: orgPolicies.orgId,
            // `updatedAt` is set explicitly on the update too: the column's
            // default only fires on insert, and this timestamp is what tells
            // "off" from "never configured" on the screen that draws it.
            set: { requireLeastPrivilege: input.requireLeastPrivilege, updatedAt: new Date() },
          })
          .returning();
        // Only when it actually moved. A form saved twice is one decision, and a
        // trail that records the second save as an act would have an incident
        // reader hunting for what changed at a timestamp where nothing did.
        if (before.requireLeastPrivilege !== input.requireLeastPrivilege) {
          const actor = await actorFromRequest(this.database.db, req);
          await recordSecurityEvent(
            this.database.db,
            {
              event: "ORG_POLICY_CHANGED",
              orgId,
              ...actor,
              metadata: {
                from: { requireLeastPrivilege: before.requireLeastPrivilege },
                to: { requireLeastPrivilege: input.requireLeastPrivilege },
              },
            },
            (message) => this.log.warn(message),
          );
        }
        return {
          requireLeastPrivilege: saved?.requireLeastPrivilege ?? input.requireLeastPrivilege,
          updatedAt: (saved?.updatedAt ?? new Date()).toISOString(),
        };
      },
    );
  }

  @Implement(contract.listOrgs)
  listOrgs(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listOrgs, req, "session").handler(async ({ context }) => {
      const active = context.member;
      const rows = await this.database.db
        .select({
          orgId: members.orgId,
          role: members.role,
          createdAt: members.createdAt,
          name: organizations.name,
        })
        .from(members)
        .innerJoin(organizations, eq(members.orgId, organizations.id))
        .where(eq(members.userId, context.userId))
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
    return route(this.tenancy, contract.listMyInvites, req, "session").handler(
      async ({ context }) => {
        const [me] = await this.database.db
          .select({ email: user.email })
          .from(user)
          .where(eq(user.id, context.userId))
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
              // The plugin's own list-user-invitations filters on status alone, so
              // it shows expired invitations as joinable and the 400 arrives on the
              // click. An invitation nobody can accept is not pending.
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
      },
    );
  }

  // The org's security trail (#158). Written since #53, read by nothing until
  // now — the data was already there, already indexed for exactly this query,
  // and already exempt from retention.
  //
  // `owner`, not `member`. Everywhere else in this product a member reads
  // everything in their org; here every row carries a colleague's IP address and
  // user agent, and who-signed-in-from-where is not team-wide reading.
  //
  // Scoped to the caller's active org and ordered newest first, which is
  // `security_events_org_time` exactly: the schema comment says "every read is
  // one org's trail, newest first", and this is that read. The other index,
  // `security_events_actor_time`, answers "everything this account did" ACROSS
  // orgs — an operator's question during an incident, not a tenant's, so no
  // input here can ask it.
  //
  // No retention window and no plan filter, deliberately: this table is the one
  // that does not age out, because the incident that needs a row is usually
  // older than the day it is noticed.
  @Implement(contract.listSecurityEvents)
  listSecurityEvents(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listSecurityEvents, req, "owner").handler(
      async ({ input, context }) => {
        const orgId = context.member.orgId;
        const filters = [eq(securityEvents.orgId, orgId)];
        if (input.event !== undefined) filters.push(eq(securityEvents.event, input.event));
        if (input.actorUserId !== undefined) {
          filters.push(eq(securityEvents.actorUserId, input.actorUserId));
        }
        // The total is of what MATCHES, not of the trail: a filtered page saying
        // "100 of 4,312" when 4,312 is the unfiltered count would describe rows
        // the reader did not ask for.
        const [counted] = await this.database.db
          .select({ total: sql<number>`count(*)::int` })
          .from(securityEvents)
          .where(and(...filters));

        const page = [...filters];
        // Keyset, not offset. The trail grows at the head — a sign-in lands
        // between two page loads — and an offset page would then repeat the row
        // that was pushed across the boundary. The compound comparison is what
        // makes it exact: `created_at` alone would skip a row that shares the
        // microsecond with the cursor, and an invitation being accepted writes
        // two rows in one request.
        if (input.beforeCreatedAt !== undefined && input.beforeId !== undefined) {
          page.push(
            sql`(${securityEvents.createdAt}, ${securityEvents.id}) < (${new Date(input.beforeCreatedAt)}, ${input.beforeId}::uuid)`,
          );
        }
        // One more than the page, to learn whether there IS a next page without
        // a second count — and the extra row is dropped rather than sent.
        const rows = await this.database.db
          .select()
          .from(securityEvents)
          .where(and(...page))
          .orderBy(desc(securityEvents.createdAt), desc(securityEvents.id))
          .limit(SECURITY_TRAIL_PAGE + 1);
        const events = rows.slice(0, SECURITY_TRAIL_PAGE);
        const more = rows.length > SECURITY_TRAIL_PAGE;
        const last = events[events.length - 1];
        return {
          events: events.map((row) => ({
            id: row.id,
            event: row.event,
            actorUserId: row.actorUserId,
            actorEmail: row.actorEmail,
            target: row.target,
            clusterId: row.clusterId,
            metadata: row.metadata,
            ipAddress: row.ipAddress,
            userAgent: row.userAgent,
            createdAt: row.createdAt.toISOString(),
          })),
          total: counted?.total ?? events.length,
          // Null at the end of the trail, so the page can stop offering "older"
          // rather than fetching an empty one to find out.
          nextCreatedAt: more && last !== undefined ? last.createdAt.toISOString() : null,
          nextId: more && last !== undefined ? last.id : null,
        };
      },
    );
  }
}
