import { Injectable } from "@nestjs/common";
import {
  and,
  clusters,
  type Database,
  desc,
  eq,
  inArray,
  indexSnapshots,
  ne,
  notInArray,
  recommendations,
  sql,
} from "../db";
import { DatabaseService } from "../db/database.service";

export type ClusterRow = typeof clusters.$inferSelect;

// The queries behind the clusters feature.
//
// Earned by one rule rather than by the count (#333). "This cluster, but only if
// the caller's org owns it" is the tenancy boundary for every act here — rename,
// mode, observe selection, disconnect — and it was written out as the same
// two-term `and(...)` at each of them. Written once now, in `owned`, so a new
// endpoint cannot get it subtly wrong and a reader can see there is exactly one
// definition of what ownership means.
//
// The scoping is deliberately in the WHERE rather than in a check before it:
// another tenant's cluster comes back as "not found" instead of being renamed,
// and the two cannot come apart under a race.
@Injectable()
export class ClustersRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  // The one predicate this whole feature is scoped by.
  private owned(clusterId: string, orgId: string) {
    return and(eq(clusters.id, clusterId), eq(clusters.orgId, orgId));
  }

  listForOrg(orgId: string): Promise<ClusterRow[]> {
    return this.db
      .select()
      .from(clusters)
      .where(eq(clusters.orgId, orgId))
      .orderBy(desc(clusters.createdAt));
  }

  // One grouped query for freshness rather than one per cluster.
  //
  // max(last_seen_at), not max(captured_at): a cluster whose indexes are all idle
  // stops writing new rows and only extends the ones it has, so captured_at would
  // freeze at the last time anything changed and the dashboard would report a
  // healthy cluster as last collected weeks ago.
  async lastCollectedByCluster(clusterIds: readonly string[]): Promise<Map<string, Date | null>> {
    if (clusterIds.length === 0) return new Map();
    const freshness = await this.db
      .select({
        clusterId: indexSnapshots.clusterId,
        lastCollectedAt: sql<Date | null>`max(${indexSnapshots.lastSeenAt})`,
      })
      .from(indexSnapshots)
      .where(inArray(indexSnapshots.clusterId, [...clusterIds]))
      .groupBy(indexSnapshots.clusterId);
    return new Map(
      freshness.map((entry) => [
        entry.clusterId,
        entry.lastCollectedAt === null ? null : new Date(entry.lastCollectedAt),
      ]),
    );
  }

  async ownedById(clusterId: string, orgId: string): Promise<ClusterRow | undefined> {
    const [row] = await this.db
      .select()
      .from(clusters)
      .where(this.owned(clusterId, orgId))
      .limit(1);
    return row;
  }

  // Pre-check for the duplicate-name refusal. The unique constraint is what
  // actually decides — two writers racing on one name would both find nothing
  // here — so this exists to give the common case a message instead of a 23505.
  async nameTaken(orgId: string, name: string, exceptClusterId?: string): Promise<boolean> {
    const [taken] = await this.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(
        and(
          eq(clusters.orgId, orgId),
          eq(clusters.name, name),
          ...(exceptClusterId === undefined ? [] : [ne(clusters.id, exceptClusterId)]),
        ),
      )
      .limit(1);
    return taken !== undefined;
  }

  async rename(clusterId: string, orgId: string, name: string): Promise<ClusterRow | undefined> {
    const [row] = await this.db
      .update(clusters)
      .set({ name })
      .where(this.owned(clusterId, orgId))
      .returning();
    return row;
  }

  async setMode(
    clusterId: string,
    orgId: string,
    readOnly: boolean,
  ): Promise<ClusterRow | undefined> {
    const [row] = await this.db
      .update(clusters)
      .set({ readOnly })
      .where(this.owned(clusterId, orgId))
      .returning();
    return row;
  }

  async setObservedDatabases(
    clusterId: string,
    orgId: string,
    databases: string[] | null,
  ): Promise<ClusterRow | undefined> {
    const [row] = await this.db
      .update(clusters)
      .set({ observedDatabases: databases })
      .where(this.owned(clusterId, orgId))
      .returning();
    return row;
  }

  // Not scoped by org: the caller has already been answered NOT_FOUND if it does
  // not own this cluster, and the row it is about to delete is the one it just
  // read under that scope.
  async deleteById(clusterId: string): Promise<void> {
    await this.db.delete(clusters).where(eq(clusters.id, clusterId));
  }

  // Delete the open proposals whose database is no longer observed, and return
  // how many. Nothing is deleted when the selection is null (every database is in
  // scope) or when it only grew.
  //
  // Only the states where nothing has happened on the customer's cluster yet.
  // HIDDEN, OBSERVE and BUILDING are excluded deliberately — the engine has
  // already changed something there, the row is the only record of it, and
  // offboard.ts reads exactly those states to put it back.
  async discardProposalsOutsideScope(
    clusterId: string,
    observed: readonly string[] | null,
  ): Promise<number> {
    if (observed === null) return 0;
    const discarded = await this.db
      .delete(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          inArray(recommendations.state, ["PROPOSED", "APPROVED", "SCHEDULED"]),
          notInArray(recommendations.database, [...observed]),
        ),
      )
      .returning({ id: recommendations.id });
    return discarded.length;
  }

  // A collect walks every collection and can take minutes on a large cluster, so
  // it is handed to the worker and the dashboard polls for the result rather than
  // the request being held open.
  async queueCollect(clusterId: string): Promise<void> {
    await this.db.execute(
      sql`select graphile_worker.add_job('collect', json_build_object('clusterId', ${clusterId}::text), max_attempts => 3)`,
    );
  }
}
