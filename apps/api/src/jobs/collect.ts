import type { IndexSpec } from "@repo/core";
import { clusters, createDatabase, envKeyProvider, eq, indexSnapshots, open } from "@repo/db";
import { type IndexUsageStat, MongoConnection, MongoIndexCollector } from "@repo/mongo";
import { masterKeyBytes, requiredEnv } from "../env";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);

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

// Connect to a cluster's Mongo (unsealing its conn string), then snapshot every
// index's spec + size + per-member usage into Postgres. Returns rows written.
export async function collectCluster(clusterId: string): Promise<number> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId)).limit(1);
  if (cluster === undefined) throw new Error(`cluster not found: ${clusterId}`);

  const keyProvider = envKeyProvider(masterKeyBytes());
  const connString = new TextDecoder().decode(
    await open({ dek: cluster.sealedDek, data: cluster.sealedData }, keyProvider),
  );

  const conn = new MongoConnection(connString);
  await conn.connect();
  try {
    const collector = new MongoIndexCollector(conn);
    const databases = (await conn.listDatabaseNames()).filter(
      (name) => !SYSTEM_DATABASES.has(name),
    );

    let written = 0;
    for (const database of databases) {
      for (const collection of await collector.listCollectionNames(database)) {
        const [specs, usage, sizes] = await Promise.all([
          collector.listIndexes(database, collection),
          collector.collectUsage(database, collection),
          collector.indexSizes(database, collection),
        ]);
        const usageByIndex = groupByIndex(usage);
        for (const spec of specs) {
          await db.insert(indexSnapshots).values({
            clusterId,
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
          written += 1;
        }
      }
    }
    return written;
  } finally {
    await conn.close();
  }
}
