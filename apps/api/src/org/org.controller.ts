import { Controller, Req } from "@nestjs/common";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { RequestActorService } from "../audit/request-actor.service";
import { TenancyService } from "../http/tenancy.service";
import { Implement, route } from "../orpc/implement";
import { OrgService } from "./org.service";

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
//
// The trail's `owner` level is the only place in this product where a member
// cannot read something in their own org: every row carries a colleague's IP
// address and user agent, and who-signed-in-from-where is not team-wide reading.
@Controller()
export class OrgController {
  // No DatabaseService: every query this controller used to reach for is behind
  // OrgService, and the last direct use was resolving the actor for the trail,
  // which is AuditService's now (#354).
  constructor(
    private readonly tenancy: TenancyService,
    private readonly org: OrgService,
    private readonly actors: RequestActorService,
  ) {}

  @Implement(contract.getOrg)
  getOrg(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getOrg, req, "session").handler(({ context }) =>
      this.org.overview(context.member),
    );
  }

  // The org's policy on its own, for a caller that wants it without the member
  // list. Readable by any member: it is a rule that governs what THEY can do
  // when they connect a cluster, and a refusal whose reason a reader cannot look
  // up is a refusal they will read as a bug.
  @Implement(contract.getOrgPolicy)
  getOrgPolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getOrgPolicy, req, "member").handler(({ context }) =>
      this.org.policy(context.member.orgId),
    );
  }

  // Owner-only, and replaced whole the way the per-cluster knobs are.
  //
  // `owner` rather than `freshOwner`, which rotating and going live are on the
  // other side of. Those three change what the control plane HOLDS on somebody's
  // production database; this one changes what it will agree to hold NEXT time.
  //
  // Reading the actor off the request — its address and user agent — is this
  // layer's job, so it is handed down as a thunk: the service decides whether
  // the save was a real change and therefore whether anyone has to be
  // identified at all.
  @Implement(contract.updateOrgPolicy)
  updateOrgPolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.updateOrgPolicy, req, "owner").handler(
      ({ input, context }) =>
        this.org.savePolicy(context.member.orgId, input.requireLeastPrivilege, () =>
          this.actors.actorFromRequest(req),
        ),
    );
  }

  @Implement(contract.listOrgs)
  listOrgs(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listOrgs, req, "session").handler(({ context }) =>
      this.org.listForUser(context.userId, context.member?.orgId ?? null),
    );
  }

  @Implement(contract.listMyInvites)
  listMyInvites(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listMyInvites, req, "session").handler(({ context }) =>
      this.org.invitesFor(context.userId),
    );
  }

  // The org's security trail (#158). Written since #53, read by nothing until
  // now — the data was already there, already indexed for exactly this query,
  // and already exempt from retention.
  @Implement(contract.listSecurityEvents)
  listSecurityEvents(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listSecurityEvents, req, "owner").handler(
      ({ input, context }) => this.org.securityTrail(context.member.orgId, input),
    );
  }
}
