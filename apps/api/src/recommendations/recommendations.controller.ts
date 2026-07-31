import { Controller, Req } from "@nestjs/common";
import { implement } from "@orpc/nest";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { parseStoredSpec, rebuildKeys } from "../analysis";
import { actions, and, clusters, desc, eq, recommendations, roiMetrics } from "../db";
import { DatabaseService } from "../db/database.service";
import { mapClusterError, toRecommendation } from "../http/mappers";
import { TenancyService } from "../http/tenancy.service";
import { openClusterSession } from "../jobs/cluster-connection";
import { recordManualVeto } from "../jobs/cooldowns";
import { Implement } from "../orpc/implement";

// How long a cancelled drop stays off the table before the engine may propose
// it again — long enough that an owner is not re-rejecting the same row weekly.
const VETO_COOLDOWN_DAYS = 90;

// A drop rollback token carries the dropped index serialized spec.
const rollbackTokenSchema = z.object({ spec: z.unknown() });

// The recommendations themselves and the three things a human can do to one:
// approve it, cancel it while it is hidden, or undo it after the drop.
@Controller()
export class RecommendationsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
  ) {}

  @Implement(contract.listRecommendations)
  listRecommendations(@Req() req: FastifyRequest) {
    return implement(contract.listRecommendations).handler(async ({ input }) => {
      const orgId = await this.tenancy.org(req);
      if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) return [];
      const rows = await this.database.db
        .select()
        .from(recommendations)
        .where(eq(recommendations.clusterId, input.clusterId));
      return rows.map(toRecommendation);
    });
  }

  @Implement(contract.approveRecommendation)
  approveRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.approveRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      const [owned] = await this.database.db
        .select({ id: recommendations.id })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      const [row] = await this.database.db
        .update(recommendations)
        .set({ state: "APPROVED", updatedAt: new Date() })
        .where(eq(recommendations.id, input.id))
        .returning();
      if (row === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      return toRecommendation(row);
    });
  }

  // Undo a drop: rebuild the index from the spec captured at drop time, correct
  // the ROI headline with a negative row, and mark the recommendation ROLLED_BACK.
  @Implement(contract.rollbackRecommendation)
  rollbackRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.rollbackRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      const [owned] = await this.database.db
        .select({ rec: recommendations })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      const rec = owned.rec;
      if (rec.state !== "DROPPED") {
        throw errors.CONFLICT({ message: "only a dropped index can be undone" });
      }
      const dropActions = await this.database.db
        .select()
        .from(actions)
        .where(and(eq(actions.recommendationId, rec.id), eq(actions.kind, "DROP")))
        .orderBy(desc(actions.createdAt));
      const withToken = dropActions.find((action) => action.rollbackToken !== null);
      if (withToken === undefined || withToken.rollbackToken === null) {
        throw errors.CONFLICT({ message: "no rollback token recorded for this drop" });
      }
      let keys: Record<string, 1 | -1> | null = null;
      let indexName = rec.indexName;
      let collation: string | null = null;
      try {
        const spec = parseStoredSpec(rollbackTokenSchema.parse(withToken.rollbackToken).spec);
        keys = rebuildKeys(spec);
        indexName = spec.name;
        collation = spec.collation;
      } catch {
        keys = null;
      }
      if (keys === null) {
        throw errors.CONFLICT({ message: "stored spec cannot be rebuilt automatically" });
      }
      try {
        const { session, readOnly, release } = await openClusterSession(
          this.database.db,
          rec.clusterId,
        );
        try {
          if (readOnly) {
            throw errors.CONFLICT({ message: "cluster is read-only" });
          }
          const executor = session.executor(readOnly);
          await executor.create(rec.database, rec.collection, keys, {
            name: indexName,
            ...(collation === null ? {} : { collation: { locale: collation } }),
          });
        } finally {
          release();
        }
      } catch (error) {
        mapClusterError(error);
      }
      // The freed bytes are spent again — correct the ROI headline, attributed
      // so the per-index list nets this recommendation back out.
      await this.database.db.insert(roiMetrics).values({
        clusterId: rec.clusterId,
        recommendationId: rec.id,
        freedBytes: -rec.estimatedBytesSaved,
        indexCountDelta: -1,
        periodStart: new Date(),
        periodEnd: new Date(),
      });
      const [updated] = await this.database.db
        .update(recommendations)
        .set({ state: "ROLLED_BACK", updatedAt: new Date() })
        .where(eq(recommendations.id, rec.id))
        .returning();
      if (updated === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      await this.database.db.insert(actions).values({
        recommendationId: rec.id,
        kind: "ROLLBACK",
        actor: "user",
        result: "ok",
      });
      return toRecommendation(updated);
    });
  }

  // Owner-only: cancel a pending drop while the index is still hidden.
  //
  // Until now the only ways out of HIDDEN were automatic — the regression gate,
  // a counter reset, a failed pre-flight — or disconnecting the cluster. An
  // owner who simply knew the index was needed had to wait out the window.
  @Implement(contract.unhideRecommendation)
  unhideRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.unhideRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      const [rec] = await this.database.db
        .select({ rec: recommendations })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1)
        .then((rows) => rows.map((row) => row.rec));
      if (rec === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      if (rec.state !== "HIDDEN") {
        throw errors.CONFLICT({ message: "only a hidden index can be un-hidden" });
      }

      try {
        const { session, readOnly, release } = await openClusterSession(
          this.database.db,
          rec.clusterId,
        );
        try {
          if (readOnly) throw errors.CONFLICT({ message: "cluster is read-only" });
          await session.executor(readOnly).unhide(rec.database, rec.collection, rec.indexName);
        } finally {
          release();
        }
      } catch (error) {
        mapClusterError(error);
      }

      // Park it, so the next classify pass does not propose the same drop
      // straight back. Not counted as a regression — nothing regressed, an
      // owner just knows something the engine does not.
      const until = await recordManualVeto(
        this.database.db,
        rec.clusterId,
        { database: rec.database, collection: rec.collection, indexName: rec.indexName },
        VETO_COOLDOWN_DAYS,
        "drop cancelled by an owner",
      );
      const day = until.toISOString().slice(0, 10);
      const [updated] = await this.database.db
        .update(recommendations)
        .set({
          state: "REJECTED",
          hiddenAt: null,
          observeDays: null,
          baselineReadOps: null,
          baselineReadLatency: null,
          rationale: `${rec.rationale} — cancelled by an owner; not re-proposed until ${day}`,
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id))
        .returning();
      if (updated === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      await this.database.db.insert(actions).values({
        recommendationId: rec.id,
        kind: "HIDE",
        actor: "user",
        result: `un-hidden on request; cooling down until ${day}`,
      });
      return toRecommendation(updated);
    });
  }
}
