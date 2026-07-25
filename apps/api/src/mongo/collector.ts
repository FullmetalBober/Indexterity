import { z } from "zod";
import type { IndexDirection, IndexKey, IndexSpec, QueryShape } from "../analysis";
import type { MongoConnection } from "./connection";

// One index's usage on one replica-set member ($indexStats is per-member; on a
// sharded cluster mongos merges every shard's members, tagged by host).
export interface IndexUsageStat {
  readonly indexName: string;
  readonly host: string;
  readonly ops: number;
  readonly since: string;
}

export interface LatencyPair {
  readonly ops: number;
  readonly latencyMicros: number;
}

export interface CollectionLatency {
  readonly reads: LatencyPair;
  readonly writes: LatencyPair;
}

export interface IndexCollector {
  listCollectionNames(database: string): Promise<string[]>;
  listIndexes(database: string, collection: string): Promise<IndexSpec[]>;
  collectUsage(database: string, collection: string): Promise<IndexUsageStat[]>;
  indexSizes(database: string, collection: string): Promise<Record<string, number>>;
  readLatency(database: string, collection: string): Promise<LatencyPair>;
  collectionLatency(database: string, collection: string): Promise<CollectionLatency>;
  collectSlowQueries(database: string, collection: string): Promise<QueryShape[]>;
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

const latencyPair = z.object({ ops: z.coerce.number(), latency: z.coerce.number() });
const latencyStatsDoc = z.object({
  latencyStats: z.object({ reads: latencyPair, writes: latencyPair }),
});

// config.collections entry on a sharded cluster: `key` is the shard-key pattern.
// _id is the "db.coll" namespace string (not an ObjectId), so the collection is
// typed to let findOne filter on it.
interface ConfigCollectionDoc {
  _id: string;
  key: Record<string, number | string>;
  dropped?: boolean;
}
const shardCollectionDoc = z.object({
  key: z.record(z.string(), z.union([z.number(), z.string()])),
});

const collectionInfo = z.object({ name: z.string() });

// system.profile entry (lenient — only field names are used downstream).
const profileDoc = z.object({
  ns: z.string(),
  planSummary: z.string().optional(),
  command: z.object({ filter: z.record(z.string(), z.unknown()).optional() }).optional(),
});

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
    isShardKey: false,
  };
}

// The shard key must be a prefix of a backing index; Mongo forbids dropping the
// last such index, so any index the shard key prefixes is treated as protected.
function shardKeyIsPrefix(shardKey: readonly string[], indexFields: readonly string[]): boolean {
  if (shardKey.length === 0 || shardKey.length > indexFields.length) return false;
  return shardKey.every((field, i) => indexFields[i] === field);
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

  // The shard-key field order for a namespace, or null when the collection is
  // unsharded (or the connection's role can't read config — treated as unsharded).
  private async shardKeyFields(database: string, collection: string): Promise<string[] | null> {
    try {
      const raw = await this.conn
        .db("config")
        .collection<ConfigCollectionDoc>("collections")
        .findOne({ _id: `${database}.${collection}`, dropped: { $ne: true } });
      if (raw === null) return null;
      return Object.keys(shardCollectionDoc.parse(raw).key);
    } catch {
      return null;
    }
  }

  async listIndexes(database: string, collection: string): Promise<IndexSpec[]> {
    const raw = await this.conn.db(database).collection(collection).indexes();
    const specs = indexDescription.array().parse(raw).map(toIndexSpec);
    const shardKey = await this.shardKeyFields(database, collection);
    if (shardKey === null) return specs;
    return specs.map((spec) => ({
      ...spec,
      isShardKey: shardKeyIsPrefix(
        shardKey,
        spec.keys.map((key) => key.field),
      ),
    }));
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

  // Sum index sizes across every $collStats doc — one per shard on a sharded
  // collection, a single doc otherwise.
  async indexSizes(database: string, collection: string): Promise<Record<string, number>> {
    const raw = await this.conn
      .db(database)
      .collection(collection)
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray();
    const totals: Record<string, number> = {};
    for (const doc of collStatsDoc.array().parse(raw)) {
      for (const [name, size] of Object.entries(doc.storageStats.indexSizes)) {
        totals[name] = (totals[name] ?? 0) + size;
      }
    }
    return totals;
  }

  // Cumulative read + write latency for the collection ($collStats latencyStats),
  // summed across every shard. The regression + ROI signal. No documents read.
  async collectionLatency(database: string, collection: string): Promise<CollectionLatency> {
    const raw = await this.conn
      .db(database)
      .collection(collection)
      .aggregate([{ $collStats: { latencyStats: {} } }])
      .toArray();
    const reads = { ops: 0, latencyMicros: 0 };
    const writes = { ops: 0, latencyMicros: 0 };
    for (const doc of latencyStatsDoc.array().parse(raw)) {
      reads.ops += doc.latencyStats.reads.ops;
      reads.latencyMicros += doc.latencyStats.reads.latency;
      writes.ops += doc.latencyStats.writes.ops;
      writes.latencyMicros += doc.latencyStats.writes.latency;
    }
    return { reads, writes };
  }

  async readLatency(database: string, collection: string): Promise<LatencyPair> {
    const { reads } = await this.collectionLatency(database, collection);
    return reads;
  }

  // Read slow queries from system.profile and aggregate by filter-field shape.
  // Requires profiler read access (the opt-in workload-analysis trust tier).
  async collectSlowQueries(database: string, collection: string): Promise<QueryShape[]> {
    const ns = `${database}.${collection}`;
    const raw = await this.conn.db(database).collection("system.profile").find({ ns }).toArray();
    const shapes = new Map<string, { fields: string[]; collscan: boolean; count: number }>();
    for (const entry of profileDoc.array().parse(raw)) {
      const filter = entry.command?.filter;
      if (filter === undefined) continue;
      const fields = Object.keys(filter).filter((field) => !field.startsWith("$"));
      if (fields.length === 0) continue;
      const key = fields.join(",");
      const collscan = (entry.planSummary ?? "").includes("COLLSCAN");
      const prev = shapes.get(key);
      if (prev === undefined) {
        shapes.set(key, { fields, collscan, count: 1 });
      } else {
        prev.count += 1;
        prev.collscan = prev.collscan || collscan;
      }
    }
    return [...shapes.values()].map((shape) => ({
      filterFields: shape.fields,
      collscan: shape.collscan,
      count: shape.count,
    }));
  }
}
