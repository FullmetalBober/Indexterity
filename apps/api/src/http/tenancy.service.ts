import { Injectable } from "@nestjs/common";
import { ORPCError } from "@orpc/server";
import { SESSION_FRESH_AGE_SECONDS } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { requireSession } from "../auth/session";
import { type Membership, resolveMembership } from "../auth/tenancy";
import {
  allowsAutoApply,
  allowsWorkloadAnalysis,
  type Plan,
  planFrom,
  withinLimit,
} from "../billing/plans";
import { seatsUsed } from "../billing/usage";
import { and, clusters, eq, organizations } from "../db";
import { DatabaseService } from "../db/database.service";

// Authn + tenancy, shared by every controller. Was four private methods copied
// into one 950-line controller; the rules are identical everywhere, so they
// belong in one place rather than in whichever controller happens to need them.
@Injectable()
export class TenancyService {
  constructor(private readonly database: DatabaseService) {}

  // 401 without a valid session; null when the caller is in no organization.
  async memberOrNull(req: FastifyRequest): Promise<Membership | null> {
    const session = await requireSession(req);
    return resolveMembership(this.database.db, session.userId, session.activeOrgId);
  }

  // 401 without a valid session, else the caller's membership.
  //
  // "No organization" is a state now that orgs are created on purpose rather
  // than conjured on first use, and it is not an error the api can fix — the
  // reader has to make one. The reads the dashboard shell performs answer it
  // with emptiness instead (listClusters, getOrg, listOrgs); everything else
  // says so, because a cluster with no org to hold it is not a request that can
  // succeed.
  async member(req: FastifyRequest): Promise<Membership> {
    const membership = await this.memberOrNull(req);
    if (membership === null) {
      throw new ORPCError("FORBIDDEN", {
        message: "create an organization before connecting anything to it",
      });
    }
    return membership;
  }

  async org(req: FastifyRequest): Promise<string> {
    return (await this.member(req)).orgId;
  }

  async orgOrNull(req: FastifyRequest): Promise<string | null> {
    return (await this.memberOrNull(req))?.orgId ?? null;
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

  // Owner, AND signed in within the last hour. The tier above requireOwner for
  // the three acts whose blast radius is the customer's database rather than
  // this product: going live, rotating credentials, disconnecting (#52). "Are
  // you an owner" and "are you here right now" are different questions — a
  // session stolen with the laptop it lives on answers the first for a week.
  //
  // Measured from when the session was CREATED, not last used: the rolling
  // refresh keeps a session alive precisely without the caller proving
  // anything, so "recently refreshed" is not evidence of presence. Signing in
  // again mints a new session row, which is how the dashboard clears this —
  // its own code, so the re-auth dialog knows this refusal from a plain 403.
  //
  // De-escalation must never wait on a password: flipping a cluster BACK to
  // read-only takes requireOwner only, so the emergency stop works from any
  // owner session however old (clusters.controller.ts setClusterMode).
  async requireFreshOwner(req: FastifyRequest): Promise<string> {
    const orgId = await this.requireOwner(req);
    // Resolved once per request (auth/session.ts), so this re-ask is free.
    const session = await requireSession(req);
    const ageMs = Date.now() - session.signedInAt.getTime();
    if (ageMs >= SESSION_FRESH_AGE_SECONDS * 1000) {
      throw new ORPCError("SESSION_NOT_FRESH", {
        status: 403,
        message: "you signed in a while ago — confirm your password to do this",
      });
    }
    return orgId;
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
        : await seatsUsed(this.database.db, orgId);
    const verdict = withinLimit(plan, what, current);
    if (!verdict.allowed) {
      throw new ORPCError("PLAN_LIMIT", { status: 402, message: verdict.reason ?? "plan limit" });
    }
  }

  async requireAutoApply(orgId: string): Promise<void> {
    const verdict = allowsAutoApply(await this.plan(orgId));
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

  async ownsCluster(clusterId: string, orgId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(and(eq(clusters.id, clusterId), eq(clusters.orgId, orgId)))
      .limit(1);
    return row !== undefined;
  }
}
