import { Controller, Req } from "@nestjs/common";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { eq, policies } from "../db";
import { DatabaseService } from "../db/database.service";
import { TenancyService } from "../http/tenancy.service";
import { Implement, route } from "../orpc/implement";

// The per-cluster engine knobs. Reads are open to members; writes are
// owner-only and replace the whole policy.
@Controller()
export class PolicyController {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
  ) {}

  @Implement(contract.getPolicy)
  getPolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getPolicy, req, "member").handler(
      async ({ input, errors, context }) => {
        await this.tenancy.assertOwnsCluster(input.clusterId, context.member.orgId, errors);
        const [row] = await this.database.db
          .select()
          .from(policies)
          .where(eq(policies.clusterId, input.clusterId))
          .limit(1);
        return {
          clusterId: input.clusterId,
          workloadAnalysis: row?.workloadAnalysis ?? false,
          instantCreate: row?.instantCreate ?? false,
          observeWindowDays: row?.observeWindowDays ?? 30,
          maxCollectionSizeBytes: row?.maxCollectionSizeBytes ?? null,
          autoApplyScore: row?.autoApplyScore ?? null,
          changeWindowStartHour: row?.changeWindowStartHour ?? null,
          changeWindowEndHour: row?.changeWindowEndHour ?? null,
          inferredWindowStartHour: row?.inferredWindowStartHour ?? null,
          inferredWindowEndHour: row?.inferredWindowEndHour ?? null,
          inferredWindowReason: row?.inferredWindowReason ?? null,
        };
      },
    );
  }

  // Owner-only: replace the cluster's engine knobs.
  @Implement(contract.updatePolicy)
  updatePolicy(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.updatePolicy, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        // Only when switching it ON — an org whose plan changed under it must
        // still be able to save the rest of its policy, and to turn this off.
        if (input.workloadAnalysis) await this.tenancy.requireWorkloadAnalysis(orgId);
        // Only when switching automation ON. Turning it off, or saving anything
        // else, must stay possible after a downgrade.
        if (input.autoApplyScore !== null || input.instantCreate) {
          await this.tenancy.requireAutoApply(orgId);
        }
        const { clusterId, ...knobs } = input;
        await this.tenancy.assertOwnsCluster(clusterId, orgId, errors);
        const [saved] = await this.database.db
          .insert(policies)
          .values({ clusterId, ...knobs })
          .onConflictDoUpdate({ target: policies.clusterId, set: knobs })
          .returning();
        // Echo the engine's window back too — clearing the explicit one hands
        // the choice back to the engine, and the UI needs to say so immediately.
        return {
          clusterId,
          ...knobs,
          inferredWindowStartHour: saved?.inferredWindowStartHour ?? null,
          inferredWindowEndHour: saved?.inferredWindowEndHour ?? null,
          inferredWindowReason: saved?.inferredWindowReason ?? null,
        };
      },
    );
  }
}
