import { type IndexInput, parseStoredSpec, recommendForCollection } from "../analysis";
import { and, eq, indexCooldowns, indexSnapshots, recommendations } from "../db";
import { activeCooldownKeys, cooldownKey } from "./cooldowns";
import { jobDb } from "./db";

// Enough history to attempt periodic detection; below this, usage reads FLAT_ZERO.
// A hole larger than this means we stopped watching, so absence of usage
// proves nothing (see analysis/classify.ts). Two days spans a missed collect
// or two at the 6h cadence without tolerating an outage.
const CLASSIFY_OPTIONS = { recentWindow: 3, minHistory: 3, maxGapHours: 48 };

// Read a cluster's snapshots, run the pure engine per collection, and replace
// the cluster's PROPOSED recommendations. Returns the number proposed.
export async function classifyCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const cooled = await activeCooldownKeys(db, clusterId);
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
    for (const candidate of recommendForCollection(
      inputs,
      sizes,
      CLASSIFY_OPTIONS,
      pastRegressions,
    )) {
      if (cooled.has(cooldownKey(entry.database, entry.collection, candidate.indexName))) continue;
      toInsert.push({
        clusterId,
        type: candidate.type,
        usageClass: candidate.usageClass,
        state: "PROPOSED",
        database: entry.database,
        collection: entry.collection,
        indexName: candidate.indexName,
        rationale: candidate.rationale,
        score: candidate.score,
        estimatedBytesSaved: candidate.estimatedBytesSaved,
      });
    }
  }

  await db
    .delete(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "PROPOSED")));
  if (toInsert.length > 0) await db.insert(recommendations).values(toInsert);
  return toInsert.length;
}
