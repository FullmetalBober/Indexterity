import type { IndexSpec } from "../analysis";
import type { EngineSession, IndexUsageStat } from "../engine/ports";

// One index snapshot, ready to persist or ship to the control plane. Shared by
// the hosted-direct worker and the customer-side agent.
export interface CollectedSnapshot {
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
  readonly spec: Record<string, unknown>;
  readonly sizeBytes: number;
  readonly perMember: { member: string; ops: number; since?: string }[];
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
    for (const collection of await collector.listCollectionNames(database)) {
      const [specs, usage, sizes, collLatency] = await Promise.all([
        collector.listIndexes(database, collection),
        collector.collectUsage(database, collection),
        collector.indexSizes(database, collection),
        collector.collectionLatency(database, collection),
      ]);
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
