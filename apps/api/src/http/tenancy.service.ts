import { Injectable } from "@nestjs/common";
import { ORPCError } from "@orpc/server";
import type { FastifyRequest } from "fastify";
import { requireUserId } from "../auth/session";
import { type Membership, resolveMembership } from "../auth/tenancy";
import { allowsWorkloadAnalysis, type Plan, planFrom, withinLimit } from "../billing/plans";
import { and, clusters, eq, invites, isNull, members, organizations } from "../db";
import { DatabaseService } from "../db/database.service";

// Authn + tenancy, shared by every controller. Was four private methods copied
// into one 950-line controller; the rules are identical everywhere, so they
// belong in one place rather than in whichever controller happens to need them.
@Injectable()
export class TenancyService {
  constructor(private readonly database: DatabaseService) {}

  // 401 without a valid session, else the caller's membership.
  async member(req: FastifyRequest): Promise<Membership> {
    return resolveMembership(this.database.db, await requireUserId(req));
  }

  async org(req: FastifyRequest): Promise<string> {
    return (await this.member(req)).orgId;
  }

  // Mutations (connect cluster, mode, approve, undo, collect) are owner-only;
  // members read everything.
  async requireOwner(req: FastifyRequest): Promise<string> {
    const member = await this.member(req);
    if (member.role !== "owner") {
      throw new ORPCError("FORBIDDEN", { message: "owner role required" });
    }
    return member.orgId;
  }

  async plan(orgId: string): Promise<Plan> {
    const [row] = await this.database.db
      .select({ plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return planFrom(row?.plan);
  }

  // Refuse when the plan has no room left for one more.
  //
  // 402 rather than 403: the caller is signed in and is an owner, so "forbidden"
  // would send them looking for a permissions problem they do not have. The
  // distinction is what lets the dashboard offer an upgrade instead of "ask an
  // owner", and the message says which limit and what to do about it.
  async requireRoomFor(orgId: string, what: "clusters" | "members"): Promise<void> {
    const plan = await this.plan(orgId);
    const current =
      what === "clusters"
        ? await this.countClusters(orgId)
        : await this.countMembersAndInvites(orgId);
    const verdict = withinLimit(plan, what, current);
    if (!verdict.allowed) {
      throw new ORPCError("PLAN_LIMIT", { status: 402, message: verdict.reason ?? "plan limit" });
    }
  }

  async requireWorkloadAnalysis(orgId: string): Promise<void> {
    const verdict = allowsWorkloadAnalysis(await this.plan(orgId));
    if (!verdict.allowed) {
      throw new ORPCError("PLAN_LIMIT", { status: 402, message: verdict.reason ?? "plan limit" });
    }
  }

  private async countClusters(orgId: string): Promise<number> {
    const rows = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(eq(clusters.orgId, orgId));
    return rows.length;
  }

  // Pending invites count against the seat limit. They are seats already
  // promised — not counting them would let an org invite past its plan and
  // discover the problem only when someone tries to accept, which punishes the
  // wrong person.
  private async countMembersAndInvites(orgId: string): Promise<number> {
    const [current, pending] = await Promise.all([
      this.database.db.select({ id: members.id }).from(members).where(eq(members.orgId, orgId)),
      this.database.db
        .select({ id: invites.id })
        .from(invites)
        .where(and(eq(invites.orgId, orgId), isNull(invites.acceptedAt))),
    ]);
    return current.length + pending.length;
  }

  async ownsCluster(clusterId: string, orgId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(and(eq(clusters.id, clusterId), eq(clusters.orgId, orgId)))
      .limit(1);
    return row !== undefined;
  }
}
