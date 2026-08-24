import { Injectable } from "@nestjs/common";
import {
  actions,
  analysisNotes,
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

export type RecommendationRow = typeof recommendations.$inferSelect;

// A recommendation plus the two things about its CLUSTER that decide whether it
// can be approved — fetched in the join the ownership check is already making
// (#244), rather than as a second read.
export interface OwnedForApproval {
  readonly id: string;
  readonly database: string;
  readonly observedDatabases: string[] | null;
  readonly readOnly: boolean;
}

// The reads and writes behind the recommendation views and the three acts.
//
// This feature earns a repository on the same test insights did, and the
// deciding query is `ownedBy`: "this recommendation, but only if the caller's
// org owns its cluster" was written out four times, in four slightly different
// column selections, and it is the tenancy boundary for every act here. One
// shape, one place.
//
// The per-member usage read is here for the second reason — its correctness
// argument is about run-length STORAGE and microsecond timestamps, not about
// what the screen shows.
@Injectable()
export class RecommendationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async countFor(clusterId: string): Promise<number | undefined> {
    const [counted] = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(recommendations)
      .where(eq(recommendations.clusterId, clusterId));
    return counted?.total;
  }

  // D33's default sort — score descending, size as the tiebreak — applied in SQL
  // rather than left to the client, because a cap without an order is a random
  // sample.
  async topFor(clusterId: string, limit: number): Promise<RecommendationRow[]> {
    return this.database.db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, clusterId))
      .orderBy(desc(recommendations.score), desc(recommendations.estimatedBytesSaved))
      .limit(limit);
  }

  // Every producer's note, not only classify's. They are stored separately
  // because they explain unrelated things — the usage gate refusing has nothing
  // to do with a crowded collection (#281) — and read together because a reader
  // is asking one question: why is this list as short as it is.
  async analysisNotesFor(clusterId: string) {
    return this.database.db
      .select()
      .from(analysisNotes)
      .where(eq(analysisNotes.clusterId, clusterId));
  }

  // The last collect's batch of index snapshots, with their namespaces.
  //
  // Read as the LAST COLLECT'S BATCH rather than by a time window: run-length
  // storage means an idle index's `captured_at` can be weeks old while the index
  // is very much still there, so the batch is identified by `last_seen_at` —
  // every index the last collect saw was either extended or inserted at that
  // moment.
  //
  // No plan window. This is the current reading rather than history, and a plan
  // cannot be entitled to less than what is true now (jobs/plan.ts).
  async latestPerMemberUsage(clusterId: string) {
    return this.database.db
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
  }

  // The tenancy boundary for every act on a recommendation: undefined when the
  // row does not exist OR belongs to another organization, which the callers
  // report identically and on purpose.
  async ownedBy(id: string, orgId: string): Promise<RecommendationRow | undefined> {
    const [row] = await this.database.db
      .select({ rec: recommendations })
      .from(recommendations)
      .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
      .where(and(eq(recommendations.id, id), eq(clusters.orgId, orgId)))
      .limit(1);
    return row?.rec;
  }

  async ownedForApproval(id: string, orgId: string): Promise<OwnedForApproval | undefined> {
    const [row] = await this.database.db
      .select({
        id: recommendations.id,
        database: recommendations.database,
        observedDatabases: clusters.observedDatabases,
        readOnly: clusters.readOnly,
      })
      .from(recommendations)
      .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
      .where(and(eq(recommendations.id, id), eq(clusters.orgId, orgId)))
      .limit(1);
    return row;
  }

  async setState(
    id: string,
    patch: Partial<typeof recommendations.$inferInsert>,
  ): Promise<RecommendationRow | undefined> {
    const [row] = await this.database.db
      .update(recommendations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(recommendations.id, id))
      .returning();
    return row;
  }

  async dropActionsFor(recommendationId: string) {
    return this.database.db
      .select()
      .from(actions)
      .where(and(eq(actions.recommendationId, recommendationId), eq(actions.kind, "DROP")))
      .orderBy(desc(actions.createdAt));
  }

  async recordAction(recommendationId: string, kind: "HIDE" | "ROLLBACK", result: string) {
    await this.database.db
      .insert(actions)
      .values({ recommendationId, kind, actor: "user", result });
  }

  // The window in force, which is the stored one or the policy baseline it fell
  // back to — the same reading finalize does.
  async observeWindowBaseline(clusterId: string): Promise<number | undefined> {
    const [policy] = await this.database.db
      .select({ observeWindowDays: policies.observeWindowDays })
      .from(policies)
      .where(eq(policies.clusterId, clusterId))
      .limit(1);
    return policy?.observeWindowDays;
  }

  // The freed bytes are spent again — correct the ROI headline, attributed so
  // the per-index list nets this recommendation back out.
  async recordRollbackCorrection(rec: RecommendationRow) {
    await this.database.db.insert(roiMetrics).values({
      clusterId: rec.clusterId,
      recommendationId: rec.id,
      freedBytes: -rec.estimatedBytesSaved,
      indexCountDelta: -1,
      periodStart: new Date(),
      periodEnd: new Date(),
    });
  }
}
