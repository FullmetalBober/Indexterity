import { Injectable, Logger } from "@nestjs/common";
import type { MyInvite, OrgInfo, OrgPolicyView, OrgSummary, SecurityTrail } from "@repo/contracts";
import { SECURITY_TRAIL_PAGE } from "@repo/contracts";
import { AuditService } from "../audit/audit.service";
import type { RequestActor } from "../audit/audit.types";
import type { Membership } from "../auth/tenancy";
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

// What a trail page is filtered and positioned by. The cursor is both halves or
// neither — a time without its tiebreak would skip a row that shares the
// microsecond, and an invitation being accepted writes two rows in one request.
export interface SecurityTrailQuery {
  readonly event?: string;
  readonly actorUserId?: string;
  readonly beforeCreatedAt?: string;
  readonly beforeId?: string;
}

// The org reads better-auth's organization plugin cannot answer, as use cases
// rather than as request handlers.
//
// Sixteen queries and no repository: fourteen are a single select against one
// table and read as part of the use case that wants them, and the two that are
// not — the trail's count and its keyset page — are one cohesive pair whose
// whole subtlety is that they filter identically. Behind a repository the pair
// would be split from the paragraph explaining it.
@Injectable()
export class OrgService {
  private readonly log = new Logger(OrgService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // Infinity does not survive JSON, so an absent limit is null.
  private static cap(value: number): number | null {
    return Number.isFinite(value) ? value : null;
  }

  // Null for a caller in no organization. Not an error: the dashboard draws a
  // create-org screen for it, and a 404 would make the shell's three reads look
  // like a broken api.
  async overview(membership: Membership | null): Promise<OrgInfo | null> {
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
      this.database.db.select({ id: clusters.id }).from(clusters).where(eq(clusters.orgId, orgId)),
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
        maxClusters: OrgService.cap(limits.maxClusters),
        maxMembers: OrgService.cap(limits.maxMembers),
        workloadAnalysis: limits.workloadAnalysis,
        autoApply: limits.autoApply,
        clustersUsed: clusterRows.length,
        // Seats are members plus outstanding invites — the same count the limit
        // is enforced on, so the number on screen matches the refusal.
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
  }

  async policy(orgId: string): Promise<OrgPolicyView> {
    const policy = await orgPolicyFor(this.database.db, orgId);
    return {
      requireLeastPrivilege: policy.requireLeastPrivilege,
      updatedAt: policy.updatedAt?.toISOString() ?? null,
    };
  }

  // Replaced whole, the way the per-cluster knobs are. It cannot loosen anything
  // already stored — the clusters sealed under the old rule keep running and are
  // marked out of policy instead — and it is recorded in the security trail
  // either way, because turning it off is what lets the next connect store an
  // admin string.
  //
  // The actor arrives as a THUNK rather than a value. Who is asking is a
  // property of the request and this class does not take one, but resolving it
  // costs a session read and a select — and the trail is only written when the
  // value actually moved, so a form saved twice must not pay for it.
  async savePolicy(
    orgId: string,
    requireLeastPrivilege: boolean,
    actor: () => Promise<RequestActor>,
  ): Promise<OrgPolicyView> {
    const before = await orgPolicyFor(this.database.db, orgId);
    const [saved] = await this.database.db
      .insert(orgPolicies)
      .values({ orgId, requireLeastPrivilege, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: orgPolicies.orgId,
        // `updatedAt` is set explicitly on the update too: the column's default
        // only fires on insert, and this timestamp is what tells "off" from
        // "never configured" on the screen that draws it.
        set: { requireLeastPrivilege, updatedAt: new Date() },
      })
      .returning();
    // Only when it actually moved. A form saved twice is one decision, and a
    // trail that records the second save as an act would have an incident reader
    // hunting for what changed at a timestamp where nothing did.
    if (before.requireLeastPrivilege !== requireLeastPrivilege) {
      await this.audit.record(
        {
          event: "ORG_POLICY_CHANGED",
          orgId,
          ...(await actor()),
          metadata: {
            from: { requireLeastPrivilege: before.requireLeastPrivilege },
            to: { requireLeastPrivilege },
          },
        },
        (message) => this.log.warn(message),
      );
    }
    return {
      requireLeastPrivilege: saved?.requireLeastPrivilege ?? requireLeastPrivilege,
      updatedAt: (saved?.updatedAt ?? new Date()).toISOString(),
    };
  }

  // Every org the caller is in, with their role in each — which
  // `organization.list` does not return.
  async listForUser(userId: string, activeOrgId: string | null): Promise<OrgSummary[]> {
    const rows = await this.database.db
      .select({
        orgId: members.orgId,
        role: members.role,
        createdAt: members.createdAt,
        name: organizations.name,
      })
      .from(members)
      .innerJoin(organizations, eq(members.orgId, organizations.id))
      .where(eq(members.userId, userId))
      .orderBy(asc(members.createdAt));
    return rows.map((row) => ({
      orgId: row.orgId,
      name: row.name,
      role: row.role,
      active: row.orgId === activeOrgId,
    }));
  }

  async invitesFor(userId: string): Promise<MyInvite[]> {
    const [me] = await this.database.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
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
          // The plugin lowercases the address it stores; user.email is stored as
          // typed, so this is compared the same way the accept endpoint compares
          // it rather than a way that happens to work today.
          eq(invites.email, me.email.toLowerCase()),
          eq(invites.status, "pending"),
          // The plugin's own list-user-invitations filters on status alone, so it
          // shows expired invitations as joinable and the 400 arrives on the
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
  }

  // One org's trail, newest first — `security_events_org_time` exactly. The
  // other index, `security_events_actor_time`, answers "everything this account
  // did" ACROSS orgs, an operator's question rather than a tenant's, so no input
  // here can ask it.
  //
  // No retention window and no plan filter, deliberately: this table is the one
  // that does not age out, because the incident that needs a row is usually
  // older than the day it is noticed.
  async securityTrail(orgId: string, query: SecurityTrailQuery): Promise<SecurityTrail> {
    const filters = [eq(securityEvents.orgId, orgId)];
    if (query.event !== undefined) filters.push(eq(securityEvents.event, query.event));
    if (query.actorUserId !== undefined) {
      filters.push(eq(securityEvents.actorUserId, query.actorUserId));
    }
    // The total is of what MATCHES, not of the trail: a filtered page saying
    // "100 of 4,312" when 4,312 is the unfiltered count would describe rows the
    // reader did not ask for.
    const [counted] = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(and(...filters));

    const page = [...filters];
    // Keyset, not offset. The trail grows at the head — a sign-in lands between
    // two page loads — and an offset page would then repeat the row that was
    // pushed across the boundary. The compound comparison is what makes it
    // exact: `created_at` alone would skip a row that shares the microsecond
    // with the cursor.
    if (query.beforeCreatedAt !== undefined && query.beforeId !== undefined) {
      page.push(
        sql`(${securityEvents.createdAt}, ${securityEvents.id}) < (${new Date(query.beforeCreatedAt)}, ${query.beforeId}::uuid)`,
      );
    }
    // One more than the page, to learn whether there IS a next page without a
    // second count — and the extra row is dropped rather than sent.
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
  }
}
