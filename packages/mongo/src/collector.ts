import type { IndexDirection, IndexKey, IndexSpec } from "@repo/core";
import { z } from "zod";
import type { MongoConnection } from "./connection";

// One index's usage on one replica-set member ($indexStats is per-member).
export interface IndexUsageStat {
  readonly indexName: string;
  readonly host: string;
  readonly ops: number;
  readonly since: string;
}

export interface IndexCollector {
  listCollectionNames(database: string): Promise<string[]>;
  listIndexes(database: string, collection: string): Promise<IndexSpec[]>;
  collectUsage(database: string, collection: string): Promise<IndexUsageStat[]>;
  indexSizes(database: string, collection: string): Promise<Record<string, number>>;
  readLatency(
    database: string,
    collection: string,
  ): Promise<{ ops: number; latencyMicros: number }>;
}

// Parse driver output at the boundary so nothing downstream sees `any`.
const indexDescription = z.object({
  name: z.string(),
  key: z.record(z.string(), z.union([z.number(), z.string()])),
  unique: z.boolean().optional(),
  sparse: z.boolean().optional(),
  hidden: z.boolean().optional(),
  expireAfterSeconds: z.number().optional(),
  partialFilterExpression: z.record(z.string(), z.unknown()).optional(),
});

const indexStat = z.object({
  name: z.string(),
  host: z.string(),
  // ops arrives as a number thanks to the driver's promoteLongs default.
  accesses: z.object({ ops: z.coerce.number(), since: z.coerce.date() }),
});

const collStatsDoc = z.object({
  storageStats: z.object({ indexSizes: z.record(z.string(), z.coerce.number()) }),
});

const latencyStatsDoc = z.object({
  latencyStats: z.object({
    reads: z.object({ ops: z.coerce.number(), latency: z.coerce.number() }),
  }),
});

const collectionInfo = z.object({ name: z.string() });

function normalizeDirection(direction: number | string): IndexDirection {
  if (direction === 1 || direction === -1) return direction;
  if (direction === "2dsphere" || direction === "text" || direction === "hashed") {
    return direction;
  }
  return 1;
}

function toIndexSpec(desc: z.infer<typeof indexDescription>): IndexSpec {
  const keys: IndexKey[] = Object.entries(desc.key).map(([field, direction]) => ({
    field,
    direction: normalizeDirection(direction),
  }));
  return {
    name: desc.name,
    keys,
    unique: desc.unique ?? false,
    ttl: desc.expireAfterSeconds !== undefined,
    partial: desc.partialFilterExpression !== undefined,
    sparse: desc.sparse ?? false,
    hidden: desc.hidden ?? false,
    // Shard-key detection needs config.collections; wired in a later pass.
    isShardKey: false,
  };
}

export class MongoIndexCollector implements IndexCollector {
  constructor(private readonly conn: MongoConnection) {}

  async listCollectionNames(database: string): Promise<string[]> {
    const raw = await this.conn.db(database).listCollections().toArray();
    return collectionInfo
      .array()
      .parse(raw)
      .map((info) => info.name)
      .filter((name) => !name.startsWith("system."));
  }

  async listIndexes(database: string, collection: string): Promise<IndexSpec[]> {
    const raw = await this.conn.db(database).collection(collection).indexes();
    return indexDescription.array().parse(raw).map(toIndexSpec);
  }

  async collectUsage(database: string, collection: string): Promise<IndexUsageStat[]> {
    const raw = await this.conn
      .db(database)
      .collection(collection)
      .aggregate([{ $indexStats: {} }])
      .toArray();
    return indexStat
      .array()
      .parse(raw)
      .map((doc) => ({
        indexName: doc.name,
        host: doc.host,
        ops: doc.accesses.ops,
        since: doc.accesses.since.toISOString(),
      }));
  }

  async indexSizes(database: string, collection: string): Promise<Record<string, number>> {
    const raw = await this.conn
      .db(database)
      .collection(collection)
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray();
    const first = raw[0];
    if (first === undefined) return {};
    return collStatsDoc.parse(first).storageStats.indexSizes;
  }

  // Cumulative read latency for the collection ($collStats latencyStats) — the
  // regression signal during observe. No document data is read.
  async readLatency(
    database: string,
    collection: string,
  ): Promise<{ ops: number; latencyMicros: number }> {
    const raw = await this.conn
      .db(database)
      .collection(collection)
      .aggregate([{ $collStats: { latencyStats: {} } }])
      .toArray();
    const first = raw[0];
    if (first === undefined) return { ops: 0, latencyMicros: 0 };
    const parsed = latencyStatsDoc.parse(first);
    return { ops: parsed.latencyStats.reads.ops, latencyMicros: parsed.latencyStats.reads.latency };
  }
}
