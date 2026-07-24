import type { IndexSpec } from "@repo/core";
import { type IndexUsageStat, MongoIndexCollector } from "./collector";
import type { MongoConnection } from "./connection";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);

// One index snapshot, ready to persist or ship to the control plane. Shared by
// the hosted-direct worker and the customer-side agent.
export interface CollectedSnapshot {
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
  readonly spec: Record<string, unknown>;
  readonly sizeBytes: number;
  readonly perMember: { member: string; ops: number }[];
}

export function serializeSpec(spec: IndexSpec): Record<string, unknown> {
  return {
    name: spec.name,
    keys: spec.keys.map((key) => ({ field: key.field, direction: key.direction })),
    unique: spec.unique,
    ttl: spec.ttl,
    partial: spec.partial,
    sparse: spec.sparse,
    hidden: spec.hidden,
    isShardKey: spec.isShardKey,
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

// Collect every index's spec + size + per-member usage across a Mongo connection.
export async function collectSnapshots(conn: MongoConnection): Promise<CollectedSnapshot[]> {
  const collector = new MongoIndexCollector(conn);
  const databases = (await conn.listDatabaseNames()).filter((name) => !SYSTEM_DATABASES.has(name));
  const snapshots: CollectedSnapshot[] = [];
  for (const database of databases) {
    for (const collection of await collector.listCollectionNames(database)) {
      const [specs, usage, sizes] = await Promise.all([
        collector.listIndexes(database, collection),
        collector.collectUsage(database, collection),
        collector.indexSizes(database, collection),
      ]);
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
          })),
        });
      }
    }
  }
  return snapshots;
}
