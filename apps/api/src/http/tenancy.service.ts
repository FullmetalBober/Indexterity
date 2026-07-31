import { Injectable } from "@nestjs/common";
import { ORPCError } from "@orpc/server";
import type { FastifyRequest } from "fastify";
import { requireUserId } from "../auth/session";
import { type Membership, resolveMembership } from "../auth/tenancy";
import { and, clusters, eq } from "../db";
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

  async ownsCluster(clusterId: string, orgId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(and(eq(clusters.id, clusterId), eq(clusters.orgId, orgId)))
      .limit(1);
    return row !== undefined;
  }
}
