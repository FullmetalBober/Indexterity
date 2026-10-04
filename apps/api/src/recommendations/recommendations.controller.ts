import { Controller, Req } from "@nestjs/common";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { TenancyService } from "../http/tenancy.service";
import { Implement, route } from "../orpc/implement";
import { RecommendationsService } from "./recommendations.service";

// The recommendations themselves and the three things a human can do to one:
// approve it, cancel it while it is hidden, or undo it after the drop.
//
// The three acts hand their own `errors` map down, because every refusal they
// raise is declared on the contract and the dashboard branches on the code.
@Controller()
export class RecommendationsController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly recommendations: RecommendationsService,
  ) {}

  @Implement(contract.listRecommendations)
  listRecommendations(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listRecommendations, req, "member").handler(
      ({ input, context }) => this.recommendations.list(input.clusterId, context.member.orgId),
    );
  }

  @Implement(contract.approveRecommendation)
  approveRecommendation(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.approveRecommendation, req, "owner").handler(
      ({ input, errors, context }) =>
        this.recommendations.approve(input.id, context.member.orgId, errors),
    );
  }

  @Implement(contract.rollbackRecommendation)
  rollbackRecommendation(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.rollbackRecommendation, req, "owner").handler(
      ({ input, errors, context }) =>
        this.recommendations.rollback(input.id, context.member.orgId, errors),
    );
  }

  @Implement(contract.unhideRecommendation)
  unhideRecommendation(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.unhideRecommendation, req, "owner").handler(
      ({ input, errors, context }) =>
        this.recommendations.unhide(input.id, context.member.orgId, errors, input.cooldownDays),
    );
  }

  @Implement(contract.shortenObserveWindow)
  shortenObserveWindow(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.shortenObserveWindow, req, "owner").handler(
      ({ input, errors, context }) =>
        this.recommendations.shortenObserveWindow(
          input.id,
          context.member.orgId,
          input.days,
          errors,
        ),
    );
  }
}
