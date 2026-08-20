import { Controller, Req } from "@nestjs/common";
import type { IndexUsage } from "@repo/contracts";
import { contract, RECOMMENDATIONS_CAP } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { DEFAULT_OBSERVE_DAYS, parseStoredSpec, rebuildKeys, rebuildOptions } from "../analysis";
import {
  actions,
  and,
  clusterIndexes,
  clusters,
  desc,
  eq,
  indexSnapshots,
  policies,
  recommendations,
  roiMetrics,
  sql,
} from "../db";
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
          return { clusterId: input.clusterId, total: 0, recommendations: [], usage: [] };
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
          usage: await this.usageFor(input.clusterId, rows),
        };
      },
    );
  }

  // Per-member usage for the indexes above (#161), from the last collect.
  //
  // `per_member` has been collected on every member the cluster admits to since
  // #99/#102 made member discovery real — and every reader summed it before it
  // reached the screen, so the whole point of collecting per member was spent on
  // making the total honest. An index whose 40,000 ops are all on one secondary
  // is serving a reporting replica; dropping it breaks something nobody was
  // watching. Spread evenly, the same 40,000 is the application. The engine's
  // usage class cannot tell them apart either.
  //
  // Read as the LAST COLLECT'S BATCH, the same way getCollections does and for
  // the same reason: run-length storage means an idle index's `captured_at` can
  // be weeks old while the index is very much still there, so the batch is
  // identified by `last_seen_at` — every index the last collect saw was either
  // extended or inserted at that moment.
  //
  // No plan window. This is the current reading rather than history, and a plan
  // cannot be entitled to less than what is true now (jobs/plan.ts).
  private async usageFor(
    clusterId: string,
    rows: readonly (typeof recommendations.$inferSelect)[],
  ): Promise<IndexUsage[]> {
    if (rows.length === 0) return [];
    const snapshotRows = await this.database.db
      .select({
        database: clusterIndexes.database,
        collection: clusterIndexes.collection,
        indexName: clusterIndexes.indexName,
        perMember: indexSnapshots.perMember,
        lastSeenAt: indexSnapshots.lastSeenAt,
      })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(
        and(
          eq(indexSnapshots.clusterId, clusterId),
          // Stays in SQL: pg keeps microseconds and a JS Date round-trip
          // truncates to ms, so re-querying by an equal Date matches nothing.
          sql`${indexSnapshots.lastSeenAt} = (select max(${indexSnapshots.lastSeenAt}) from ${indexSnapshots} where ${indexSnapshots.clusterId} = ${clusterId})`,
        ),
      );
    // One index name can have several dimension rows — a rebuild is keyed by
    // spec digest, so the identity outlives the shape (db/schema.ts). Newest
    // wins; they share `last_seen_at` here, so ties keep the first, which is
    // the one the collect wrote for the spec the index has now.
    const byNamespace = new Map<string, (typeof snapshotRows)[number]>();
    for (const row of snapshotRows) {
      const key = `${row.database}\u0000${row.collection}\u0000${row.indexName}`;
      const held = byNamespace.get(key);
      if (held === undefined || row.lastSeenAt > held.lastSeenAt) byNamespace.set(key, row);
    }
    return rows.flatMap((rec) => {
      const snapshot = byNamespace.get(
        `${rec.database}\u0000${rec.collection}\u0000${rec.indexName}`,
      );
      // No row rather than zeroes: the last collect did not see this index, and
      // "0 ops on 0 members" is a measurement nobody took.
      if (snapshot === undefined) return [];
      return [
        {
          recommendationId: rec.id,
          totalOps: snapshot.perMember.reduce((sum, member) => sum + member.ops, 0),
          // Busiest first, which is the order that makes concentration visible
          // at a glance — the reader is looking for one member carrying it all.
          perMember: [...snapshot.perMember]
            .map((member) => ({ member: member.member, ops: member.ops }))
            .sort((a, b) => b.ops - a.ops || a.member.localeCompare(b.member)),
          observedAt: snapshot.lastSeenAt.toISOString(),
        },
      ];
    });
  }

  @Implement(contract.approveRecommendation)
  approveRecommendation(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.approveRecommendation, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        // The cluster's observe selection comes back with the ownership check, in
        // the join that is already being made (#244).
        const [owned] = await this.database.db
          .select({
            id: recommendations.id,
            database: recommendations.database,
            observedDatabases: clusters.observedDatabases,
            readOnly: clusters.readOnly,
          })
          .from(recommendations)
          .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
          .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
          .limit(1);
        if (owned === undefined) {
          throw errors.NOT_FOUND({ message: "recommendation not found" });
        }
        // Approving is what puts a change into the apply pipeline, so it is the
        // last point at which "this database is not observed" can still be said in
        // time. Refused rather than silently dropped: the reader is looking at a
        // row on their screen, and a click that does nothing is worse than one that
        // says the list is stale.
        if (owned.observedDatabases !== null && !owned.observedDatabases.includes(owned.database)) {
          throw errors.CONFLICT({
            message:
              `${owned.database} is not one of the databases this cluster observes — ` +
              "reload the page, or add it back in the cluster's settings.",
          });
        }
        // Same reasoning, one step further out: a read-only cluster never
        // executes a write, so applyCluster returns before pre-flight and the
        // row stays APPROVED with no action, no event and nothing saying why
        // (#257). Accepting the click would be worse than the stale-list case
        // above — that one resolves on a reload, this one never resolves at all.
        if (owned.readOnly) {
          throw errors.CONFLICT({
            message:
              "this cluster is read-only, so nothing can be applied to it — " +
              "switch it to live in the cluster's settings first.",
          });
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
            observeReason: null,
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

  // Owner-only: shorten a pending drop's observe window.
  //
  // The window is decided once at hide time and frozen deliberately — recomputing
  // it every pass would make the drop date walk as history rolled out of
  // retention, and a date nobody can plan around is worse than none. The cost of
  // that freeze is that an owner who knows an index is dead has no way to say so:
  // the only exit was to cancel the drop entirely, which re-proposes it later and
  // recomputes the very same window from the very same history. This is that
  // missing move, and it is the whole of it — the drop still waits for the change
  // window and still passes the regression gate, so what this shortens is the
  // OBSERVATION and never a safety step.
  @Implement(contract.shortenObserveWindow)
  shortenObserveWindow(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.shortenObserveWindow, req, "owner").handler(
      async ({ input, errors, context }) => {
        const [rec] = await this.database.db
          .select({ rec: recommendations })
          .from(recommendations)
          .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
          .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, context.member.orgId)))
          .limit(1)
          .then((rows) => rows.map((row) => row.rec));
        if (rec === undefined) {
          throw errors.NOT_FOUND({ message: "recommendation not found" });
        }
        if (rec.state !== "HIDDEN" || rec.hiddenAt === null) {
          throw errors.CONFLICT({ message: "only a hidden index has an observe window" });
        }
        // The window in force, which is the stored one or the policy baseline it
        // fell back to — the same reading finalize does, so the ceiling below is
        // the number the drop is actually waiting on rather than a null.
        const [policy] = await this.database.db
          .select({ observeWindowDays: policies.observeWindowDays })
          .from(policies)
          .where(eq(policies.clusterId, rec.clusterId))
          .limit(1);
        const current = rec.observeDays ?? policy?.observeWindowDays ?? DEFAULT_OBSERVE_DAYS;
        // The floor, and the default. Never into the past: a window shorter than
        // the time already served is due the moment it is written, so the next
        // finalize tick would drop the index with no interval in which anyone
        // could change their mind — "shorten" would quietly be spelled "drop
        // now", which is a different feature and a more dangerous one.
        const servedDays = Math.max(
          1,
          Math.ceil((Date.now() - rec.hiddenAt.getTime()) / 86_400_000),
        );
        const days = input.days ?? servedDays;
        if (days >= current) {
          throw errors.BAD_REQUEST({
            message: `this drop is already observing for ${current} day(s) — a window can be shortened here, never lengthened`,
          });
        }
        if (days < servedDays) {
          throw errors.BAD_REQUEST({
            message: `this index has been hidden for ${servedDays} day(s); the window cannot be shortened below what it has already observed`,
          });
        }
        const [updated] = await this.database.db
          .update(recommendations)
          .set({
            observeDays: days,
            observeReason: `shortened to ${days} day(s) by an owner`,
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
          result: `observe window shortened from ${current} to ${days} day(s) on request`,
        });
        return toRecommendation(updated);
      },
    );
  }
}
