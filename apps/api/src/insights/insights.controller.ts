import { Controller, Req } from "@nestjs/common";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { TenancyService } from "../http/tenancy.service";
import { Implement, route } from "../orpc/implement";
import { InsightsService } from "./insights.service";

// Read-only views over what the engine has already decided and recorded: ROI,
// latency trends, per-collection footprint, the roster and the audit trail.
//
// Every route is `member` and every one is scoped to the caller's active org by
// the service, which answers for a cluster they do not own with an empty view
// rather than a refusal — so nothing here needs the contract's error shapes.
@Controller()
export class InsightsController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly insights: InsightsService,
  ) {}

  @Implement(contract.getRoi)
  getRoi(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getRoi, req, "member").handler(({ input, context }) =>
      this.insights.roi(input.clusterId, context.member.orgId),
    );
  }

  @Implement(contract.getLatency)
  getLatency(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getLatency, req, "member").handler(({ input, context }) =>
      this.insights.latency(input.clusterId, context.member.orgId),
    );
  }

  @Implement(contract.getLatencySeries)
  getLatencySeries(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getLatencySeries, req, "member").handler(
      ({ input, context }) => this.insights.latencySeries(input.clusterId, context.member.orgId),
    );
  }

  @Implement(contract.getIndexSizeSeries)
  getIndexSizeSeries(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getIndexSizeSeries, req, "member").handler(
      ({ input, context }) => this.insights.indexSizeSeries(input.clusterId, context.member.orgId),
    );
  }

  @Implement(contract.getCollections)
  getCollections(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getCollections, req, "member").handler(
      ({ input, context }) => this.insights.collections(input.clusterId, context.member.orgId),
    );
  }

  @Implement(contract.getClusterIndexes)
  getClusterIndexes(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getClusterIndexes, req, "member").handler(
      ({ input, context }) => {
        const { clusterId, ...query } = input;
        return this.insights.clusterIndexes(clusterId, context.member.orgId, query);
      },
    );
  }

  @Implement(contract.getClusterWorkload)
  getClusterWorkload(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getClusterWorkload, req, "member").handler(
      ({ input, context }) => {
        const { clusterId, ...query } = input;
        return this.insights.clusterWorkload(clusterId, context.member.orgId, query);
      },
    );
  }

  @Implement(contract.listCooldowns)
  listCooldowns(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listCooldowns, req, "member").handler(
      ({ input, context }) => this.insights.cooldowns(input.clusterId, context.member.orgId),
    );
  }

  // Owner-only: un-parking an index is what puts it back in front of the engine,
  // which is a decision about the cluster rather than a read of it (D136).
  @Implement(contract.clearCooldown)
  clearCooldown(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.clearCooldown, req, "owner").handler(
      ({ input, errors, context }) =>
        this.insights.clearCooldown(
          input.clusterId,
          context.member.orgId,
          {
            database: input.database,
            collection: input.collection,
            indexName: input.indexName,
          },
          errors,
        ),
    );
  }

  @Implement(contract.getNodes)
  getNodes(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getNodes, req, "member").handler(({ input, context }) =>
      this.insights.nodes(input.clusterId, context.member.orgId),
    );
  }

  @Implement(contract.listActions)
  listActions(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listActions, req, "member").handler(({ input, context }) =>
      this.insights.actions(input.clusterId, context.member.orgId),
    );
  }
}
