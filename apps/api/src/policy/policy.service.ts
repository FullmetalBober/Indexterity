import { Injectable } from "@nestjs/common";
import type { ClusterPolicy, ClusterPolicyView } from "@repo/contracts";
import { eq, policies } from "../db";
import { DatabaseService } from "../db/database.service";
import { TenancyService } from "../http/tenancy.service";

// The knobs, minus the cluster they belong to — what updatePolicy's input
// carries beside the id, and what a save replaces wholesale.
export type PolicyKnobs = Omit<ClusterPolicy, "clusterId">;

// The per-cluster engine knobs.
//
// Whether the CALLER may see or set them is the controller's question, because
// answering it needs the request; everything below is the use case itself and
// runs without one.
@Injectable()
export class PolicyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
  ) {}

  async read(clusterId: string): Promise<ClusterPolicyView> {
    const [row] = await this.database.db
      .select()
      .from(policies)
      .where(eq(policies.clusterId, clusterId))
      .limit(1);
    return {
      clusterId,
      // No policy row yet means nothing has been configured, not that this is
      // off — the column's default is what a row would carry, so the fallback
      // has to agree with it or the toggle renders a state the engine does not
      // act on (#258).
      workloadAnalysis: row?.workloadAnalysis ?? true,
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
  }

  // Replaces the whole policy. The plan gates are here rather than in the
  // controller because they are part of the act: what an organization may turn
  // ON is a rule about saving a policy, not about the shape of a request.
  async save(orgId: string, clusterId: string, knobs: PolicyKnobs): Promise<ClusterPolicyView> {
    // Only when switching it ON — an org whose plan changed under it must still
    // be able to save the rest of its policy, and to turn this off.
    if (knobs.workloadAnalysis) await this.tenancy.requireWorkloadAnalysis(orgId);
    // Only when switching automation ON. Turning it off, or saving anything
    // else, must stay possible after a downgrade.
    if (knobs.autoApplyScore !== null || knobs.instantCreate) {
      await this.tenancy.requireAutoApply(orgId);
    }
    const [saved] = await this.database.db
      .insert(policies)
      .values({ clusterId, ...knobs })
      .onConflictDoUpdate({ target: policies.clusterId, set: knobs })
      .returning();
    // Echo the engine's window back too — clearing the explicit one hands the
    // choice back to the engine, and the UI needs to say so immediately.
    return {
      clusterId,
      ...knobs,
      inferredWindowStartHour: saved?.inferredWindowStartHour ?? null,
      inferredWindowEndHour: saved?.inferredWindowEndHour ?? null,
      inferredWindowReason: saved?.inferredWindowReason ?? null,
    };
  }
}
