import { Controller, Req } from "@nestjs/common";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { TenancyService } from "../http/tenancy.service";
import { Implement, route } from "../orpc/implement";
import { PolicyService } from "./policy.service";

// The per-cluster engine knobs. Reads are open to members; writes are
// owner-only and replace the whole policy.
//
// Ownership is checked here rather than in the service because it is the one
// refusal phrased in the CONTRACT's errors — `errors.NOT_FOUND`, so a cluster in
// another organization is indistinguishable from one that does not exist.
@Controller()
export class PolicyController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly policy: PolicyService,
  ) {}

  @Implement(contract.getPolicy)
  getPolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getPolicy, req, "member").handler(
      async ({ input, errors, context }) => {
        await this.tenancy.assertOwnsCluster(input.clusterId, context.member.orgId, errors);
        return this.policy.read(input.clusterId);
      },
    );
  }

  // Owner-only: replace the cluster's engine knobs.
  @Implement(contract.updatePolicy)
  updatePolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.updatePolicy, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        const { clusterId, ...knobs } = input;
        await this.tenancy.assertOwnsCluster(clusterId, orgId, errors);
        return this.policy.save(orgId, clusterId, knobs);
      },
    );
  }
}
