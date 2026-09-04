import type { CollectionLatency, EngineSession, IndexUsageStat } from "../engine/ports";
import { DatabaseInaccessibleError } from "../engine/ports";
import type { IndexSpec } from "../engine/types";

// One index snapshot, ready to persist or ship to the control plane. Shared by
// the hosted-direct worker and the customer-side agent.
export interface CollectedSnapshot {
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
  readonly spec: Record<string, unknown>;
  readonly sizeBytes: number;
  readonly perMember: { member: string; ops: number; since?: string }[];
  // The application named this index with hint(). Hiding it would break those
  // queries rather than slow them, so it must not be auto-dropped.
  readonly hinted: boolean;
}

export interface CollectedLatency {
  readonly database: string;
  readonly collection: string;
  readonly readOps: number;
  readonly readLatencyMicros: number;
  readonly writeOps: number;
  readonly writeLatencyMicros: number;
}

export interface CollectResult {
  readonly snapshots: CollectedSnapshot[];
  readonly latency: CollectedLatency[];
}

// What a per-database read says about a collection it did not mention: nothing
// ran against it — the same zeros the per-collection read returns for one.
const NO_ACTIVITY: CollectionLatency = {
  reads: { ops: 0, latencyMicros: 0 },
  writes: { ops: 0, latencyMicros: 0 },
};

export function serializeSpec(spec: IndexSpec): Record<string, unknown> {
  return {
    name: spec.name,
    keys: spec.keys.map((key) => ({ field: key.field, direction: key.direction })),
    unique: spec.unique,
    ttl: spec.ttl,
    partial: spec.partial,
    partialFilter: spec.partialFilter,
    sparse: spec.sparse,
    hidden: spec.hidden,
    isShardKey: spec.isShardKey,
    collation: spec.collation,
    // Persisted so an undo rebuilds a covering index as covering. Kept off the
    // object entirely when the index has none, so the specs of every engine
    // without includes are unchanged.
    ...(spec.include === undefined || spec.include.length === 0 ? {} : { include: spec.include }),
  };
}

function groupByIndex(usage: IndexUsageStat[]): Record<string, IndexUsageStat[]> {
  const grouped: Record<string, IndexUsageStat[]> = {};
  for (const stat of usage) {
    const bucket = grouped[stat.indexName] ?? [];
    bucket.push(stat);
    grouped[stat.indexName] = bucket;
  }
  return grouped;
}

// Collect every index's spec + size + per-member usage, plus per-collection
// read/write latency, across an engine session (engine-neutral: written
// entirely against the collector port).
export async function collectSnapshots(session: EngineSession): Promise<CollectResult> {
  const collector = session.collector;
  const databases = await session.listDatabaseNames();
  const snapshots: CollectedSnapshot[] = [];
  const latency: CollectedLatency[] = [];
  for (const database of databases) {
    // A database the credentials cannot reach costs this pass that one database
    // and not the cluster (#244). Before this, a SQL Server login provisioned for
    // two databases of twelve aborted the whole collect on the first of the other
    // ten — so an owner who ticked a database the login had no user in lost every
    // measurement on the cluster, not just the new one's.
    //
    // Only this failure is tolerated, and it is the reason it has a type of its
    // own: any other error still aborts the pass, because a pass that swallows
    // unknown failures reports a cluster as collected when it was not.
    let collections: string[];
    try {
      collections = await collector.listCollectionNames(database);
    } catch (error) {
      if (error instanceof DatabaseInaccessibleError) continue;
      throw error;
    }
    // Latency and hints once per database where the engine offers that (#454):
    // on SQL Server the per-table read was a whole-Query-Store scan, twice per
    // table. Elsewhere the per-collection reads below are the cheap ones.
    const latencies =
      collector.latencyByCollection === undefined
        ? null
        : await collector.latencyByCollection(database);
    const hints =
      collector.hintedByCollection === undefined
        ? null
        : await collector.hintedByCollection(database, collections);
    for (const collection of collections) {
      const [specs, usage, sizes, collLatency, hinted] = await Promise.all([
        collector.listIndexes(database, collection),
        collector.collectUsage(database, collection),
        collector.indexSizes(database, collection),
        latencies === null
          ? collector.collectionLatency(database, collection)
          : Promise.resolve(latencies.get(collection) ?? NO_ACTIVITY),
        hints === null
          ? collector.collectHintedIndexes(database, collection).catch(() => [])
          : Promise.resolve(hints.get(collection) ?? []),
      ]);
      const hintedNames = new Set(hinted);
      latency.push({
        database,
        collection,
        readOps: collLatency.reads.ops,
        readLatencyMicros: collLatency.reads.latencyMicros,
        writeOps: collLatency.writes.ops,
        writeLatencyMicros: collLatency.writes.latencyMicros,
      });
      const usageByIndex = groupByIndex(usage);
      for (const spec of specs) {
        snapshots.push({
          database,
          collection,
          indexName: spec.name,
          spec: serializeSpec(spec),
          sizeBytes: sizes[spec.name] ?? 0,
          hinted: hintedNames.has(spec.name),
          perMember: (usageByIndex[spec.name] ?? []).map((stat) => ({
            member: stat.host,
            ops: stat.ops,
            // Persisted so classification can tell a restart from idleness.
            since: stat.since,
          })),
        });
      }
    }
  }
  return { snapshots, latency };
}
