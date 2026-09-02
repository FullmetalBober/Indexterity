import { Injectable } from "@nestjs/common";
import type { LatencyReading } from "../analysis";
import { runFrom } from "../analysis/types";
import {
  actions,
  analysisNotes,
  and,
  clusterIndexes,
  clusterRosters,
  desc,
  eq,
  gte,
  inArray,
  indexCooldowns,
  indexSnapshots,
  LIVE_STATES,
  latencySamples,
  ne,
  or,
  policies,
  recommendations,
  roiMetrics,
  sql,
  workloadShapes,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { historyWindow } from "../jobs/plan";

// One collection's latency counters over the window, grouped by namespace.
export interface LatencyGroup {
  readonly database: string;
  readonly collection: string;
  readonly readings: LatencyReading[];
}

// The sort key an unmeasured weekly cost stands in for (#432). Negative because
// a real one never is, so the ordering below stays total and the page's cursor
// stays a plain number — see workloadShapePage.
export const UNMEASURED_COST = -1;

export interface IndexSizeDay {
  readonly day: string;
  readonly totalBytes: number | null;
  readonly indexCount: number;
}

// The reads behind the insight views.
//
// This feature earns a repository where `policy` and `org` did not, and the
// deciding one is `readableSince`: the rule that a caller's window is clamped to
// the PLAN's window was written out twice, in the latency load and in the
// footprint series, and a third view would have written it a third time. It is
// the entitlement, so it is not a rule to keep re-deriving beside a chart.
//
// The two heavyweight queries are here for the same reason — the day-bucketing
// CTE and the max(last_seen_at) footprint join are each a paragraph of SQL whose
// correctness argument is about storage, not about what the chart means.
@Injectable()
export class InsightsRepository {
  constructor(private readonly database: DatabaseService) {}

  // How far back this cluster may be read.
  //
  // The plan's window is the entitlement, and rows outlive it — deletion runs
  // one cutoff for the whole deployment — so this is what actually enforces it.
  // `notBefore` tightens for a caller that only draws a recent slice (#64); it
  // can never loosen.
  async readableSince(clusterId: string, notBefore?: Date): Promise<Date> {
    const planSince = await historyWindow(this.database.db, clusterId);
    return notBefore !== undefined && notBefore > planSince ? notBefore : planSince;
  }

  async latencyReadings(clusterId: string, since: Date): Promise<Map<string, LatencyGroup>> {
    const rows = await this.database.db
      .select()
      .from(latencySamples)
      .where(and(eq(latencySamples.clusterId, clusterId), gte(latencySamples.lastSeenAt, since)));
    const groups = new Map<
      string,
      { database: string; collection: string; readings: LatencyReading[] }
    >();
    for (const row of rows) {
      const key = `${row.database} ${row.collection}`;
      const group = groups.get(key) ?? {
        database: row.database,
        collection: row.collection,
        readings: [],
      };
      // A row stands for every collect that read these same four counters, so
      // the trend and the chart get the interval and the count rather than
      // inferring a single look from a single row.
      group.readings.push({
        ...runFrom(row),
        readOps: row.readOps,
        readLatencyMicros: row.readLatencyMicros,
        writeOps: row.writeOps,
        writeLatencyMicros: row.writeLatencyMicros,
      });
      groups.set(key, group);
    }
    return groups;
  }

  async roiRows(clusterId: string) {
    return this.database.db.select().from(roiMetrics).where(eq(roiMetrics.clusterId, clusterId));
  }

  async recommendationsByIds(ids: readonly string[]) {
    if (ids.length === 0) return [];
    return this.database.db
      .select()
      .from(recommendations)
      .where(inArray(recommendations.id, [...ids]));
  }

  // Total index bytes per day, bucketed in SQL rather than shipped one point per
  // snapshot run. Runs are run-length encoded (#67), so the row count is a
  // function of how much the cluster CHANGES — a busy 200-index cluster writes
  // roughly four runs per index per day, which is 24,000 rows for a 30-day
  // window and a chart that draws 31 points.
  //
  // A day counts an index once, at the newest run that overlapped it, and a day
  // no run overlapped comes back null rather than zero — the difference between
  // "this cluster had no indexes" and "nobody looked". Overlap is the right test
  // and an instant is not: a busy index's runs end and restart around each
  // collect, so "the run covering midnight" would drop exactly the indexes whose
  // counters move.
  async indexSizeByDay(clusterId: string, since: Date): Promise<IndexSizeDay[]> {
    const rows = await this.database.db.execute<{
      day: Date;
      total_bytes: string | null;
      index_count: number;
    }>(sql`
      with days as (
        select generate_series(
          date_trunc('day', ${since}::timestamptz),
          date_trunc('day', now()),
          interval '1 day'
        ) as day
      ),
      -- One row per (day, index): the newest run that overlapped that day.
      -- distinct on rather than a window function because the ordering IS
      -- the choice, and because at most one run per index can be picked --
      -- the exclusion constraint on the span column guarantees a cluster's
      -- runs for one index never overlap each other.
      picked as (
        select distinct on (d.day, s.index_id) d.day as day, s.size_bytes
        from days d
        join ${indexSnapshots} s
          on s.cluster_id = ${clusterId}
         and s.last_seen_at >= ${since}
         and s.captured_at < d.day + interval '1 day'
         and s.last_seen_at >= d.day
        order by d.day, s.index_id, s.captured_at desc
      )
      select
        d.day,
        -- sum over no rows is null, which is the gap marker, so this is
        -- deliberately NOT coalesced to zero.
        sum(p.size_bytes)::bigint as total_bytes,
        count(p.size_bytes)::int as index_count
      from days d
      left join picked p on p.day = d.day
      group by d.day
      order by d.day
    `);
    // bigint arrives as a string from node-postgres — Number is exact to 9
    // petabytes, which is well past any index footprint.
    return rows.rows.map((row) => ({
      day: new Date(row.day).toISOString(),
      totalBytes: row.total_bytes === null ? null : Number(row.total_bytes),
      indexCount: Number(row.index_count),
    }));
  }

  // Every index the last collect saw, with its namespace.
  //
  // By `last_seen_at`, not `captured_at`, and the difference is the whole of
  // what run-length storage changes here. This used to select the newest BATCH
  // of inserts, which worked because a collect wrote a row per index and they
  // shared a timestamp. An idle index no longer gets a row per collect — it gets
  // its existing run extended — so its `captured_at` can be weeks old while the
  // index is very much still there, and the old comparison would have dropped it
  // from the footprint.
  //
  // The max(last_seen_at) comparison must stay in SQL: pg keeps microseconds and
  // a JS Date round-trip truncates to ms, so re-querying by an equal Date would
  // match nothing.
  async latestIndexFootprint(clusterId: string) {
    return this.database.db
      .select({
        database: clusterIndexes.database,
        collection: clusterIndexes.collection,
        sizeBytes: indexSnapshots.sizeBytes,
      })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(
        and(
          eq(indexSnapshots.clusterId, clusterId),
          sql`${indexSnapshots.lastSeenAt} = (select max(${indexSnapshots.lastSeenAt}) from ${indexSnapshots} where ${indexSnapshots.clusterId} = ${clusterId})`,
        ),
      );
  }

  // The instant the newest index reading was confirmed, or null if none ever
  // was. The inventory's "as of" — a display value, and ONLY that.
  //
  // It is deliberately not fed back in as the page's filter. Postgres keeps
  // microseconds on a timestamptz and a JS Date is milliseconds, so a value that
  // has been through this method no longer compares equal to the rows it came
  // from: re-querying `last_seen_at = ` this would match nothing at all. The
  // page's own filter keeps the comparison in SQL for that reason, which is the
  // same trap `latestIndexFootprint` documents below.
  //
  // Typed as a string, and converted here, because that is what actually comes
  // back: drizzle decodes a column by the schema's type, and a raw `sql`
  // fragment has no column for it to look up — so an aggregate arrives as
  // node-postgres left it. Writing `sql<Date>` would have been an assertion
  // dressed as a type, and it was: the first run of this endpoint died on
  // `collectedAt.toISOString is not a function`.
  async latestIndexReadingAt(clusterId: string): Promise<Date | null> {
    const [row] = await this.database.db
      .select({ at: sql<string | null>`max(${indexSnapshots.lastSeenAt})` })
      .from(indexSnapshots)
      .where(eq(indexSnapshots.clusterId, clusterId));
    if (row?.at === undefined || row.at === null) return null;
    const at = new Date(row.at);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  // One page of the cluster's index inventory (#431).
  //
  // Scoped to the runs the LATEST collect confirmed, which is what makes this
  // one row per live index rather than one per historical shape. Two things it
  // rests on, both already true of the writer: a collect stamps every run it
  // touches with one `now` (jobs/collect.ts), and the exclusion constraint on
  // `span` forbids two runs of one index overlapping — so an index seen by that
  // collect has exactly one row here, and a REBUILT index's older dimension row
  // has a run that ended earlier and is therefore absent. Filtering by
  // `captured_at` instead would drop every idle index, whose run may have
  // started weeks ago: that is the same mistake `latestIndexFootprint` above
  // documents having made.
  //
  // OFFSET, and it was a keyset cursor until #445 (D133).
  //
  // The keyset argument was the security trail's (D67) and it is still true: the
  // set moves under the reader — a collect lands, an index is built — and an
  // offset page can then repeat or skip whatever crossed the boundary. What that
  // argument does not weigh is that a cursor can only STEP, so the reader got a
  // Back and a More button, no page number, and no way to reach the fifth page of
  // six on a cluster with 517 indexes. Browsing is the access pattern that wants
  // a page number, which is why this endpoint pages at all.
  //
  // Survivable here and NOT in the trail: a namespace is not a queue, so nothing
  // is missed by being skipped once — the row is still there on the next read,
  // under a filter, or on the page either side. An audit trail is read to
  // establish that nothing happened, and a skipped row there is a false negative
  // about a security event. Different question, different guarantee.
  //
  // The count and the page are two queries against the same filters, and the
  // count is re-run per request rather than cached in a cursor, which is what
  // makes the page count follow a set that changed size mid-browse.
  async clusterIndexPage(
    clusterId: string,
    query: {
      readonly database?: string | undefined;
      readonly collection?: string | undefined;
    },
    limit: number,
    offset: number,
  ) {
    const filters = [
      eq(indexSnapshots.clusterId, clusterId),
      // In SQL, never as a parameter round-tripped through a JS Date — see
      // latestIndexReadingAt above, and latestIndexFootprint below, which lost
      // this argument once already.
      sql`${indexSnapshots.lastSeenAt} = (select max(${indexSnapshots.lastSeenAt}) from ${indexSnapshots} where ${indexSnapshots.clusterId} = ${clusterId})`,
    ];
    if (query.database !== undefined) filters.push(eq(clusterIndexes.database, query.database));
    if (query.collection !== undefined) {
      filters.push(eq(clusterIndexes.collection, query.collection));
    }
    // The total is of what MATCHES the namespace filter, not of the cluster: a
    // filtered page saying "100 of 211" against the unfiltered count would be
    // describing rows the reader did not ask for.
    const [counted] = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(and(...filters));

    const total = counted?.total ?? 0;
    // Clamped to the last page rather than serving an empty one past the end.
    // A reader on page five who narrows the filter has asked for an offset that
    // no longer exists, and an empty table under a "517 indexes" heading reads as
    // a broken screen rather than as a moved boundary. Reported back, so the
    // control lands where the rows did.
    const start = total === 0 ? 0 : Math.min(offset, Math.max(0, total - 1));
    // To the page boundary, not to the raw offset: a clamp mid-page would serve a
    // window straddling two pages and the reader would see rows repeat.
    const from = Math.floor(start / limit) * limit;
    const rows = await this.database.db
      .select({
        id: clusterIndexes.id,
        database: clusterIndexes.database,
        collection: clusterIndexes.collection,
        indexName: clusterIndexes.indexName,
        spec: clusterIndexes.spec,
        sizeBytes: indexSnapshots.sizeBytes,
        perMember: indexSnapshots.perMember,
        hinted: indexSnapshots.hinted,
        lastSeenAt: indexSnapshots.lastSeenAt,
      })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(and(...filters))
      // The whole triple, because one cluster can hold two indexes of the same
      // name in two collections — and under offset paging a total order is no
      // longer merely tidy: rows that tie sort arbitrarily, so a partial order
      // would let the same row appear on two pages of one browse.
      .orderBy(clusterIndexes.database, clusterIndexes.collection, clusterIndexes.indexName)
      .limit(limit)
      .offset(from);
    return { rows, total, offset: from };
  }

  // Live recommendations over the namespaces one page covers.
  //
  // Scoped to the page rather than to the cluster on purpose: the whole reason
  // this endpoint pages is that an index list is unbounded, and reading every
  // proposal to decorate a hundred rows would put the unbounded read back one
  // layer down. An OR over the pairs, not a cluster-wide read filtered in
  // memory — and an OR of two equalities rather than a tuple `in`, because
  // drizzle's `inArray` binds its right-hand side as ONE parameter and a
  // row-constructor there is a runtime error rather than a type one.
  //
  // Live states only — a DROPPED or REJECTED row is history, and the column the
  // page draws is "is something proposing to change this index right now".
  async liveRecommendationsFor(
    clusterId: string,
    namespaces: readonly { readonly database: string; readonly collection: string }[],
  ) {
    if (namespaces.length === 0) return [];
    return this.database.db
      .select({
        id: recommendations.id,
        type: recommendations.type,
        state: recommendations.state,
        database: recommendations.database,
        collection: recommendations.collection,
        indexName: recommendations.indexName,
        targetSpec: recommendations.targetSpec,
      })
      .from(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          inArray(recommendations.state, [...LIVE_STATES]),
          or(
            ...namespaces.map((ns) =>
              and(
                eq(recommendations.database, ns.database),
                eq(recommendations.collection, ns.collection),
              ),
            ),
          ),
        ),
      );
  }

  // One page of the cluster's scanning workload (#432).
  //
  // Ranked by weekly cost descending rather than sorted by namespace, which is
  // the difference from `clusterIndexPage` above: an inventory is browsed and
  // this is a list of problems, so the worst ones are the answer and a reader
  // who needs the fiftieth is looking at something else.
  //
  // Ordered on `coalesce(weekly_docs_examined, -1)`, which does two things at
  // once. Postgres sorts nulls FIRST under `desc`, so a shape whose source could
  // not report examined documents — an in-memory sort, or any `$queryStats`
  // entry below mongo 8.0 — would otherwise HEAD a page ranked by cost while
  // being the one row whose cost is unknown: unmeasured is not worst. And it
  // makes the sort key total, which is what lets the cursor be a plain number
  // rather than a nullable one: a real cost is never negative, so -1 is the
  // unmeasured region and a tuple comparison works across both. Same reasoning
  // as `orNull` in the collections table, where a missing number sorts as -1 so
  // it stays out of the middle of a ranking it is not part of.
  //
  // Keyset for the reason the security trail gives (D67), with the id as the
  // tiebreak: two shapes on one collection sharing a weekly figure is ordinary,
  // and a cursor that was only the cost would skip whichever sorted second.
  async workloadShapePage(
    clusterId: string,
    since: Date,
    query: {
      readonly database?: string | undefined;
      readonly collection?: string | undefined;
      readonly declinedOnly?: boolean | undefined;
      readonly afterWeeklyDocsExamined?: number | undefined;
      readonly afterId?: string | undefined;
    },
    limit: number,
  ) {
    const filters = [
      eq(workloadShapes.clusterId, clusterId),
      // The plan's window, same entitlement as every other per-cluster read.
      // A shape last seen before it is history this caller has not bought.
      gte(workloadShapes.lastSeenAt, since),
    ];
    if (query.database !== undefined) filters.push(eq(workloadShapes.database, query.database));
    if (query.collection !== undefined) {
      filters.push(eq(workloadShapes.collection, query.collection));
    }
    // The page's own question, and the one no other screen can answer: which of
    // these did we decline to act on. `ne` rather than a list of the declining
    // outcomes, so an outcome added later is declined by default — the safe
    // direction, since the alternative is a new gate silently vanishing from the
    // filter that exists to show it.
    if (query.declinedOnly === true) filters.push(ne(workloadShapes.outcome, "proposed"));

    const [counted] = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(workloadShapes)
      .where(and(...filters));

    const page = [...filters];
    if (query.afterWeeklyDocsExamined !== undefined && query.afterId !== undefined) {
      page.push(
        sql`(coalesce(${workloadShapes.weeklyDocsExamined}, ${UNMEASURED_COST}), ${workloadShapes.id})
            < (${query.afterWeeklyDocsExamined}::bigint, ${query.afterId}::uuid)`,
      );
    }
    const rows = await this.database.db
      .select()
      .from(workloadShapes)
      .where(and(...page))
      .orderBy(
        sql`coalesce(${workloadShapes.weeklyDocsExamined}, ${UNMEASURED_COST}) desc`,
        desc(workloadShapes.id),
      )
      .limit(limit + 1);
    return { rows, total: counted?.total ?? rows.length };
  }

  // The WORKLOAD pass's own note (#277), for the two gates that can have no
  // shape rows: they fire before the workload is read, so what exists is a count
  // of COLLECTIONS nobody analysed. Read from the same row the budget count
  // already lives in.
  async workloadNote(clusterId: string) {
    const [row] = await this.database.db
      .select()
      .from(analysisNotes)
      .where(and(eq(analysisNotes.clusterId, clusterId), eq(analysisNotes.source, "WORKLOAD")))
      .limit(1);
    return row;
  }

  // Whether create-side analysis is switched off for this cluster.
  //
  // The one gate that leaves nothing at all behind — `suggestForCluster` returns
  // before it reads anything — so an empty page has two very different meanings
  // and this is which one. A MISSING policy row is not "off": that is the normal
  // state of a new cluster, and reading absence as off is what kept the whole
  // feature silent on exactly the clusters it had most to say about (#258).
  async workloadAnalysisEnabled(clusterId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ enabled: policies.workloadAnalysis })
      .from(policies)
      .where(eq(policies.clusterId, clusterId))
      .limit(1);
    return row?.enabled !== false;
  }

  async proposedNamespaces(clusterId: string) {
    return this.database.db
      .select({ database: recommendations.database, collection: recommendations.collection })
      .from(recommendations)
      .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "PROPOSED")));
  }

  // Every row, not only the ones still in force, and never joined to
  // `recommendations`. A cooldown outlives its cause: `recordManualVeto` parks an
  // index for 90 days when an owner cancels or undoes a drop, and the
  // recommendation that was cancelled is a row the next classify pass rewrites.
  // Joining would drop exactly the longest-standing entries.
  async cooldowns(clusterId: string) {
    return this.database.db
      .select()
      .from(indexCooldowns)
      .where(eq(indexCooldowns.clusterId, clusterId))
      .orderBy(desc(indexCooldowns.until));
  }

  async roster(clusterId: string) {
    const [row] = await this.database.db
      .select()
      .from(clusterRosters)
      .where(eq(clusterRosters.clusterId, clusterId))
      .limit(1);
    return row;
  }

  async recentActions(clusterId: string, limit: number) {
    return this.database.db
      .select({
        id: actions.id,
        kind: actions.kind,
        actor: actions.actor,
        result: actions.result,
        database: recommendations.database,
        collection: recommendations.collection,
        indexName: recommendations.indexName,
        createdAt: actions.createdAt,
      })
      .from(actions)
      .innerJoin(recommendations, eq(actions.recommendationId, recommendations.id))
      .where(eq(recommendations.clusterId, clusterId))
      .orderBy(desc(actions.createdAt))
      .limit(limit);
  }
}
