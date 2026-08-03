import {
  type ActivityPoint,
  activeIntervals,
  type IndexInput,
  parseStoredSpec,
  recommendForCollection,
} from "../analysis";
import {
  and,
  eq,
  inArray,
  indexCooldowns,
  indexSnapshots,
  latencySamples,
  policies,
  recommendations,
} from "../db";
import { activeCooldownKeys, cooldownKey } from "./cooldowns";
import { jobDb } from "./db";
import { pendingRemovalKeys, watchedIndexKeys, watchKey } from "./watched";

// Policy fallback, matching apply/finalize.
const DEFAULT_OBSERVE_DAYS = 30;

// Enough history to attempt periodic detection; below this, usage reads FLAT_ZERO.
// A hole larger than this means we stopped watching, so absence of usage
// proves nothing (see analysis/classify.ts). Two days spans a missed collect
// or two at the 6h cadence without tolerating an outage.
// minActiveIntervals: the collection must have served reads in at least this
// many collect intervals before "this index served none of them" is a claim.
// Twelve at the 6h cadence is three days of genuine traffic, which an
// always-on but mostly idle dev cluster can take weeks of calendar time to
// accumulate — which is exactly the point.
const CLASSIFY_OPTIONS = {
  recentWindow: 3,
  minHistory: 3,
  minHistoryDays: 7,
  minActiveIntervals: 12,
  maxGapHours: 48,
};

// Read a cluster's snapshots, run the pure engine per collection, and replace
// the cluster's PROPOSED recommendations. Returns the number proposed.
export async function classifyCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const cooled = await activeCooldownKeys(db, clusterId);
  const [policy] = await db
    .select({ observeWindowDays: policies.observeWindowDays })
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  // Indexes the engine built and is still watching are off the table — see
  // watchedIndexKeys. They stay in `inputs` below, because a new compound index
  // legitimately makes an older prefix redundant; they just cannot be the
  // subject of a finding while their own verdict is pending.
  const watched = await watchedIndexKeys(
    db,
    clusterId,
    policy?.observeWindowDays ?? DEFAULT_OBSERVE_DAYS,
  );
  // Indexes already on their way out. They stay in `inputs` but cannot justify
  // dropping anything else — see pendingRemovalKeys.
  const departing = await pendingRemovalKeys(db, clusterId);
  // Full cooldown history (active or expired): each past regression cuts the
  // confidence score of any future proposal for that index.
  const cooldownRows = await db
    .select()
    .from(indexCooldowns)
    .where(eq(indexCooldowns.clusterId, clusterId));
  const regressionCounts = new Map<string, Record<string, number>>();
  for (const row of cooldownRows) {
    const scope = `${row.database} ${row.collection}`;
    const perIndex = regressionCounts.get(scope) ?? {};
    perIndex[row.indexName] = row.regressionCount;
    regressionCounts.set(scope, perIndex);
  }
  const rows = await db
    .select()
    .from(indexSnapshots)
    .where(eq(indexSnapshots.clusterId, clusterId));
  // Per-collection read counters, for the activity gate.
  const latencyRows = await db
    .select({
      database: latencySamples.database,
      collection: latencySamples.collection,
      readOps: latencySamples.readOps,
      capturedAt: latencySamples.capturedAt,
    })
    .from(latencySamples)
    .where(eq(latencySamples.clusterId, clusterId));
  const activityByCollection = new Map<string, ActivityPoint[]>();
  for (const sample of latencyRows) {
    const key = `${sample.database}\u0000${sample.collection}`;
    const list = activityByCollection.get(key) ?? [];
    list.push({ capturedAt: sample.capturedAt.toISOString(), readOps: sample.readOps });
    activityByCollection.set(key, list);
  }
  type Row = (typeof rows)[number];

  const byCollection = new Map<
    string,
    { database: string; collection: string; byIndex: Map<string, Row[]> }
  >();
  for (const row of rows) {
    const key = `${row.database}\u0000${row.collection}`;
    let entry = byCollection.get(key);
    if (entry === undefined) {
      entry = { database: row.database, collection: row.collection, byIndex: new Map() };
      byCollection.set(key, entry);
    }
    const list = entry.byIndex.get(row.indexName) ?? [];
    list.push(row);
    entry.byIndex.set(row.indexName, list);
  }

  // Indexes the application pins with hint(). Hiding one makes mongod reject
  // those queries outright, which the read-latency gate cannot see, so they are
  // excluded from drop findings the same way a watched index is. One sighting
  // anywhere in the retained history is enough — absence is not proof either
  // way, so the signal only ever protects.
  const hintedKeys = new Set(
    rows
      .filter((row) => row.hinted)
      .map((row) => watchKey(row.database, row.collection, row.indexName)),
  );

  const toInsert: Array<typeof recommendations.$inferInsert> = [];
  for (const entry of byCollection.values()) {
    const inputs: IndexInput[] = [];
    const sizes: Record<string, number> = {};
    for (const [indexName, snaps] of entry.byIndex) {
      const sorted = [...snaps].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
      const latest = sorted.at(-1);
      if (latest === undefined) continue;
      // A dropped index frees its bytes on every replica-set member, not one
      // copy. (On sharded clusters members span shards while sizes are already
      // cluster-wide sums, so this over-approximates by the shard count — an
      // acceptable ceiling until per-shard member counts are tracked.)
      const replicaFactor = Math.max(1, latest.perMember.length);
      sizes[indexName] = latest.sizeBytes * replicaFactor;
      inputs.push({
        pendingRemoval: departing.has(watchKey(entry.database, entry.collection, indexName)),
        spec: parseStoredSpec(latest.spec),
        history: sorted.map((snap) => ({
          capturedAt: snap.capturedAt.toISOString(),
          perMember: snap.perMember.map((member) => ({
            member: member.member,
            ops: member.ops,
            // Real counter-start time when the snapshot has one; snapshots
            // taken before it was persisted simply omit it.
            ...(member.since === undefined ? {} : { since: member.since }),
          })),
        })),
      });
    }
    const pastRegressions = regressionCounts.get(`${entry.database} ${entry.collection}`) ?? {};
    const active = activeIntervals(
      activityByCollection.get(`${entry.database}\u0000${entry.collection}`) ?? [],
    );
    for (const candidate of recommendForCollection(
      inputs,
      sizes,
      CLASSIFY_OPTIONS,
      pastRegressions,
      new Date(),
      active,
    )) {
      if (cooled.has(cooldownKey(entry.database, entry.collection, candidate.indexName))) continue;
      if (watched.has(watchKey(entry.database, entry.collection, candidate.indexName))) continue;
      // Advisories still surface — a human should know a hinted index looks
      // unused. Only the automatic drop is withheld.
      if (
        candidate.type !== "ADVISORY_REVIEW" &&
        hintedKeys.has(watchKey(entry.database, entry.collection, candidate.indexName))
      ) {
        continue;
      }
      toInsert.push({
        clusterId,
        type: candidate.type,
        usageClass: candidate.usageClass,
        state: "PROPOSED",
        source: "CLASSIFY",
        database: entry.database,
        collection: entry.collection,
        indexName: candidate.indexName,
        rationale: candidate.rationale,
        score: candidate.score,
        estimatedBytesSaved: candidate.estimatedBytesSaved,
      });
    }
  }

  // Only this job's own findings. It used to clear every PROPOSED row for the
  // cluster, which quietly ate the retirement drops finalize.ts files after a
  // build graduates — and nothing re-derives those, because the replacement
  // index is the one that looks redundant next to the original, not the other
  // way round. Narrowing {a,b,c} to {a,b} depends on that row surviving.
  await db
    .delete(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        eq(recommendations.state, "PROPOSED"),
        eq(recommendations.source, "CLASSIFY"),
      ),
    );
  if (toInsert.length > 0) await db.insert(recommendations).values(toInsert);

  // Retirement rows now outlive the sweep, so something has to retract one when
  // its index goes away — the customer dropping it by hand, or a rename. A
  // proposal to drop an index that no longer exists can never be actioned and
  // would sit on the dashboard forever. Only drops: a CREATE names an index
  // that is MEANT not to exist yet.
  const live = new Set(rows.map((row) => watchKey(row.database, row.collection, row.indexName)));
  const stale = await db
    .select({
      id: recommendations.id,
      database: recommendations.database,
      collection: recommendations.collection,
      indexName: recommendations.indexName,
    })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        eq(recommendations.state, "PROPOSED"),
        inArray(recommendations.type, ["DROP_UNUSED", "DROP_REDUNDANT"]),
      ),
    );
  const gone = stale
    .filter((row) => !live.has(watchKey(row.database, row.collection, row.indexName)))
    .map((row) => row.id);
  // An empty snapshot set means the collector has not run (or the cluster went
  // unreachable), not that every index vanished.
  if (gone.length > 0 && rows.length > 0) {
    await db.delete(recommendations).where(inArray(recommendations.id, gone));
  }
  return toInsert.length;
}
