import { Controller, Req } from "@nestjs/common";
import { contract, RECOMMENDATIONS_CAP } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { parseStoredSpec, rebuildKeys, rebuildOptions } from "../analysis";
import { actions, and, clusters, desc, eq, recommendations, roiMetrics, sql } from "../db";
import { DatabaseService } from "../db/database.service";
import type { CreateIndexOptions } from "../engine/ports";
import { mapClusterError, toRecommendation } from "../http/mappers";
import { TenancyService } from "../http/tenancy.service";
import { openClusterSession } from "../jobs/cluster-connection";
import { recordManualVeto } from "../jobs/cooldowns";
import { Implement, route } from "../orpc/implement";

// How long a cancelled drop stays off the table before the engine may propose
// it again — long enough that an owner is not re-rejecting the same row weekly.
const VETO_COOLDOWN_DAYS = 90;

// The recommendations themselves and the three things a human can do to one:
// approve it, cancel it while it is hidden, or undo it after the drop.
@Controller()
export class RecommendationsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
  ) {}

  // Bounded (#64): the RECOMMENDATIONS_CAP highest-scoring rows plus the true
  // total. The order is D33's default sort — score descending, size as the
  // tiebreak — applied here rather than left to the client, because a cap
  // without an order is a random sample. Measured before deciding: 4,000
  // proposals (the one-per-index worst case) shipped 1.86 MB; the cap holds
  // the payload near 250 KB however large the cluster grows.
  @Implement(contract.listRecommendations)
  listRecommendations(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listRecommendations, req, "member").handler(
      async ({ input, context }) => {
        // Empty rather than NOT_FOUND, like the other per-cluster reads: the
        // dashboard asks for a cluster it has just been told about, and a refusal
        // there renders as a broken api rather than as an empty panel.
        if (!(await this.tenancy.ownsCluster(input.clusterId, context.member.orgId))) {
          return { clusterId: input.clusterId, total: 0, recommendations: [] };
        }
        const [counted] = await this.database.db
          .select({ total: sql<number>`count(*)::int` })
          .from(recommendations)
          .where(eq(recommendations.clusterId, input.clusterId));
        const rows = await this.database.db
          .select()
          .from(recommendations)
          .where(eq(recommendations.clusterId, input.clusterId))
          .orderBy(desc(recommendations.score), desc(recommendations.estimatedBytesSaved))
          .limit(RECOMMENDATIONS_CAP);
        return {
          clusterId: input.clusterId,
          total: counted?.total ?? rows.length,
          recommendations: rows.map(toRecommendation),
        };
      },
    );
  }

  @Implement(contract.approveRecommendation)
  approveRecommendation(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.approveRecommendation, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
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
      },
    );
  }

  // Undo a drop: rebuild the index from the spec captured at drop time, correct
  // the ROI headline with a negative row, and mark the recommendation ROLLED_BACK.
  @Implement(contract.rollbackRecommendation)
  rollbackRecommendation(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.rollbackRecommendation, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
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
        // A DROP row's token carries the spec; a CREATE row's carries a name
        // (db/schema.ts). This query asks for DROP rows only, so the `in` narrows
        // the union rather than guarding against something that happens — and it
        // is where a row written before the token existed drops out.
        const token = dropActions
          .map((action) => action.rollbackToken)
          .find((value) => value !== null && "spec" in value);
        if (token === undefined || token === null || !("spec" in token)) {
          throw errors.CONFLICT({ message: "no rollback token recorded for this drop" });
        }
        let keys: Record<string, 1 | -1> | null = null;
        // Everything the index WAS, not just its keys. An undo that restored a
        // unique index without its uniqueness would remove the constraint by
        // putting it back — see analysis/rollback.ts.
        let options: CreateIndexOptions = { name: rec.indexName };
        try {
          const spec = parseStoredSpec(token.spec);
          keys = rebuildKeys(spec);
          options = rebuildOptions(spec);
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
            await executor.create(rec.database, rec.collection, keys, options);
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
        // Park it, exactly as cancelling a pending drop does. Without this the
        // rebuilt index goes straight back into the pipeline: it carries the same
        // name, so classify reads its pre-drop history, sees the same zero usage
        // that justified the drop in the first place, and proposes it again — and
        // with an autoApplyScore set, drops it again. Undo has to mean something
        // for longer than one classify tick.
        //
        // Not a regression, for the same reason as the cancel path: nothing got
        // slower, an owner simply knows something the engine does not.
        await recordManualVeto(
          this.database.db,
          rec.clusterId,
          { database: rec.database, collection: rec.collection, indexName: rec.indexName },
          VETO_COOLDOWN_DAYS,
          "drop undone by an owner",
        );
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
      },
    );
  }

  // Owner-only: cancel a pending drop while the index is still hidden.
  //
  // Until now the only ways out of HIDDEN were automatic — the regression gate,
  // a counter reset, a failed pre-flight — or disconnecting the cluster. An
  // owner who simply knew the index was needed had to wait out the window.
  @Implement(contract.unhideRecommendation)
  unhideRecommendation(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.unhideRecommendation, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
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
      },
    );
  }
}
