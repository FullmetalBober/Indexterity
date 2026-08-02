import { z } from "zod";
import {
  type ConstantValue,
  classifyClient,
  type IndexDirection,
  type IndexKey,
  type IndexSpec,
  type LookupJoin,
  type QueryClient,
  type QueryShape,
  type ServerHealth,
  type SortKey,
} from "../analysis";
import {
  type CollectionLatency,
  type CollectionStorage,
  type DeletePattern,
  type IndexCollector,
  type IndexUsageStat,
  type LatencyPair,
  type WorkloadTarget,
  workloadKey,
} from "../engine/ports";
import type { MongoConnection } from "./connection";
import type { MemberConnections } from "./members";

// Normalize a sort spec's values into directed keys (anything odd → ascending).
function sortKeysOf(sortSpec: Record<string, unknown>): SortKey[] {
  return Object.entries(sortSpec).map(([field, value]) => ({
    field,
    direction: value === -1 ? -1 : 1,
  }));
}

function shapeMapKey(
  equality: string[],
  sort: SortKey[],
  range: string[],
  lookups: readonly LookupJoin[],
): string {
  const sortPart = sort.map((key) => `${key.field}:${key.direction}`).join(",");
  const lookupPart = lookups.map((join) => `${join.from}.${join.foreignField}`).join(",");
  return `${equality.join(",")}|${sortPart}|${range.join(",")}|${lookupPart}`;
}

// Every $lookup join in the pipeline that names a foreign field (the
// localField/foreignField form; pipeline-form lookups without foreignField
// carry no index signal). Scans ALL stages — unlike pipelineShape, a $lookup
// after a blocking stage still runs a real per-document foreign query. Field
// names are structural, so $queryStats keeps them through shapification.
export function lookupJoins(pipeline: readonly Record<string, unknown>[]): LookupJoin[] {
  const joins: LookupJoin[] = [];
  for (const stage of pipeline) {
    const lookup = stage.$lookup;
    if (!isRecord(lookup)) continue;
    const { from, foreignField } = lookup;
    if (typeof from !== "string" || typeof foreignField !== "string") continue;
    if (joins.some((join) => join.from === from && join.foreignField === foreignField)) continue;
    joins.push({ from, foreignField });
  }
  return joins;
}

// The collector CONTRACT lives in the engine-neutral ports (../engine/ports);
// this file is the MongoDB implementation. Types re-exported for convenience.
export type {
  CollectionLatency,
  CollectionStorage,
  DeletePattern,
  IndexCollector,
  IndexUsageStat,
  LatencyPair,
  WorkloadTarget,
} from "../engine/ports";

// Parse driver output at the boundary so nothing downstream sees `any`.
const indexDescription = z.object({
  name: z.string(),
  key: z.record(z.string(), z.union([z.number(), z.string()])),
  unique: z.boolean().optional(),
  sparse: z.boolean().optional(),
  hidden: z.boolean().optional(),
  expireAfterSeconds: z.number().optional(),
  partialFilterExpression: z.record(z.string(), z.unknown()).optional(),
  collation: z.object({ locale: z.string() }).passthrough().optional(),
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

const dataSizeDoc = z.object({
  storageStats: z.object({ size: z.coerce.number(), count: z.coerce.number() }),
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

// serverStatus, narrowed to the query-engine counters. Lenient throughout:
// these sub-documents move between releases, and a missing one should cost a
// signal rather than the whole reading.
const serverStatusDoc = z.object({
  metrics: z.object({
    queryExecutor: z.object({
      scanned: z.coerce.number(),
      scannedObjects: z.coerce.number(),
      collectionScans: z.object({ total: z.coerce.number() }).partial().optional(),
    }),
    operation: z.object({ scanAndOrder: z.coerce.number() }).partial().optional(),
  }),
  globalLock: z
    .object({
      currentQueue: z
        .object({ readers: z.coerce.number(), writers: z.coerce.number() })
        .partial()
        .optional(),
    })
    .optional(),
  mem: z.object({ resident: z.coerce.number() }).partial().optional(),
});

// One $queryStats entry (mongo 6.0+). Filters are shapified ({field: {$eq: "?number"}}),
// metrics arrive as Longs the driver promotes. Lenient: entries for other command
// shapes are skipped via safeParse.
const queryStatsDoc = z.object({
  key: z.object({
    // Present from 6.0; the shell and every GUI identify themselves here.
    client: z
      .object({
        application: z.object({ name: z.string() }).partial().optional(),
        driver: z.object({ name: z.string() }).partial().optional(),
      })
      .optional(),
    queryShape: z.object({
      cmdNs: z.object({ db: z.string(), coll: z.string() }),
      filter: z.record(z.string(), z.unknown()).optional(),
      sort: z.record(z.string(), z.unknown()).optional(),
      pipeline: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
  }),
  metrics: z.object({
    execCount: z.coerce.number(),
    // Absent before 8.0 — see collectQueryStats. `keysExamined` is the marker
    // the capability check reads, because it is the one that decides whether a
    // shape was scanning.
    keysExamined: z.object({ sum: z.coerce.number() }).optional(),
    docsExamined: z.object({ sum: z.coerce.number() }).optional(),
    // Executions that ran a blocking in-memory SORT, and those that did not.
    hasSortStage: z.object({ true: z.coerce.number() }).partial().optional(),
  }),
});

// system.profile entry (lenient — only field names are used downstream).
//
// The profiler is richer than `$queryStats` on every version below 8.0: it
// records the plan summary, the documents walked, whether a blocking sort ran,
// and who issued the query. It is opt-in and costs write throughput, which is
// why it is the fallback rather than the default — but where it is on, it is
// the better source.
const profileDoc = z.object({
  ns: z.string(),
  op: z.string().optional(),
  ts: z.coerce.date().optional(),
  planSummary: z.string().optional(),
  docsExamined: z.coerce.number().optional(),
  // Recorded only when true.
  hasSortStage: z.boolean().optional(),
  // The client's own name for itself — same signal as the $queryStats client
  // key, and the reason shell traffic can be discounted on the profiler path.
  appName: z.string().optional(),
  command: z
    .object({
      filter: z.record(z.string(), z.unknown()).optional(),
      sort: z.record(z.string(), z.unknown()).optional(),
      pipeline: z.array(z.record(z.string(), z.unknown())).optional(),
      q: z.record(z.string(), z.unknown()).optional(),
      // Recorded by the profiler, and by nothing else — $queryStats drops it.
      hint: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    })
    .optional(),
});

// The single date-range predicate of a delete filter, or null when the filter
// is anything else — only clean {field: {$lt/$lte: Date}} deletes count.
export function dateRangeCutoff(
  q: Record<string, unknown>,
): { field: string; cutoff: Date } | null {
  const fields = Object.keys(q).filter((field) => !field.startsWith("$"));
  const field = fields[0];
  if (fields.length !== 1 || field === undefined) return null;
  const predicate = q[field];
  if (!isRecord(predicate)) return null;
  const bound = predicate.$lt ?? predicate.$lte;
  if (!(bound instanceof Date)) return null;
  return { field, cutoff: bound };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const at = sorted[mid] ?? 0;
  const before = sorted[mid - 1] ?? at;
  return sorted.length % 2 === 0 ? (before + at) / 2 : at;
}

// Operators that produce a range (index-bound) scan rather than an equality match.
const RANGE_OPS = new Set([
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$ne",
  "$nin",
  "$in",
  "$exists",
  "$regex",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRangePredicate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => RANGE_OPS.has(key));
}

// Split a filter's fields into equality vs range predicates (flattening $and).
function collectPredicates(
  filter: Record<string, unknown>,
  equality: string[],
  range: string[],
): void {
  for (const [field, value] of Object.entries(filter)) {
    if (field === "$and" && Array.isArray(value)) {
      for (const clause of value) if (isRecord(clause)) collectPredicates(clause, equality, range);
      continue;
    }
    if (field.startsWith("$")) continue; // $or/$nor/… can't be served by one index
    if (isRangePredicate(value)) range.push(field);
    else equality.push(field);
  }
}

function isConstant(value: unknown): value is ConstantValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// Real literal values equality predicates compared against — the partial-index
// signal. PROFILER ONLY: $queryStats shapifies values into "?type" markers,
// which must never be mistaken for constants. Handles direct equality and $eq,
// flattening $and.
export function equalityConstants(filter: Record<string, unknown>): Record<string, ConstantValue> {
  const constants: Record<string, ConstantValue> = {};
  for (const [field, value] of Object.entries(filter)) {
    if (field === "$and" && Array.isArray(value)) {
      for (const clause of value) {
        if (isRecord(clause)) Object.assign(constants, equalityConstants(clause));
      }
      continue;
    }
    if (field.startsWith("$")) continue;
    if (isConstant(value)) {
      constants[field] = value;
    } else if (isRecord(value) && isConstant(value.$eq) && Object.keys(value).length === 1) {
      constants[field] = value.$eq;
    }
  }
  return constants;
}

// Keep only fields whose value matched in every sample seen so far.
function intersectConstants(
  previous: Record<string, ConstantValue>,
  next: Record<string, ConstantValue>,
): Record<string, ConstantValue> {
  const merged: Record<string, ConstantValue> = {};
  for (const [field, value] of Object.entries(previous)) {
    if (next[field] === value) merged[field] = value;
  }
  return merged;
}

export interface PipelineShape {
  readonly equality: string[];
  readonly sort: SortKey[];
  readonly range: string[];
}

// An index only serves an aggregation's LEADING $match/$sort stages — anything
// after the first blocking stage ($group/$project/$lookup/…) runs in memory.
// Null when the leading stages give an index nothing to work with.
export function pipelineShape(pipeline: readonly Record<string, unknown>[]): PipelineShape | null {
  const equality: string[] = [];
  const range: string[] = [];
  const sort: SortKey[] = [];
  for (const stage of pipeline) {
    const match = stage.$match;
    if (isRecord(match)) {
      collectPredicates(match, equality, range);
      continue;
    }
    const sortStage = stage.$sort;
    if (isRecord(sortStage)) {
      sort.push(...sortKeysOf(sortStage));
      continue;
    }
    break; // first non-$match/$sort stage ends index applicability
  }
  if (equality.length === 0 && range.length === 0 && sort.length === 0) return null;
  return { equality, sort, range };
}

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
    partialFilter: desc.partialFilterExpression ?? null,
    sparse: desc.sparse ?? false,
    hidden: desc.hidden ?? false,
    isShardKey: false,
    collation: desc.collation?.locale ?? null,
  };
}

// The shard key must be a prefix of a backing index; Mongo forbids dropping the
// last such index, so any index the shard key prefixes is treated as protected.
function shardKeyIsPrefix(shardKey: readonly string[], indexFields: readonly string[]): boolean {
  if (shardKey.length === 0 || shardKey.length > indexFields.length) return false;
  return shardKey.every((field, i) => indexFields[i] === field);
}

// One member's $indexStats. A member that fails mid-collect (stepped down,
// restarting) contributes nothing rather than failing the whole collection.
async function readIndexStats(
  conn: MongoConnection,
  database: string,
  collection: string,
): Promise<IndexUsageStat[]> {
  try {
    const raw = await conn
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
  } catch {
    return [];
  }
}

export class MongoIndexCollector implements IndexCollector {
  constructor(
    private readonly conn: MongoConnection,
    // Absent in tests and for one-off diagnostic connections, where the
    // primary's own counters are all that is being asked for.
    private readonly members?: MemberConnections,
  ) {}

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
    // Every member, not just the one the driver picked. See mongo/members.ts:
    // $indexStats is node-local, so the primary alone cannot tell a dead index
    // from one that only serves secondary reads.
    const connections = [this.conn, ...(await (this.members?.all() ?? Promise.resolve([])))];
    const perMember = await Promise.all(
      connections.map((conn) => readIndexStats(conn, database, collection)),
    );
    // Keyed by index AND host: the same index reports once per member, and each
    // member's counter has its own `since`.
    const seen = new Map<string, IndexUsageStat>();
    for (const stat of perMember.flat()) seen.set(`${stat.indexName}\u0000${stat.host}`, stat);
    return [...seen.values()];
  }

  // Uncompressed data size + document count, summed across shards. Sizes feed
  // the maxCollectionSizeBytes build ceiling; counts feed the collection-size
  // gates. Sourced from $collStats — the `count` command would need a `find`
  // grant the scoped least-privilege user deliberately lacks.
  async collectionStorage(database: string, collection: string): Promise<CollectionStorage> {
    const raw = await this.conn
      .db(database)
      .collection(collection)
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray();
    let dataSizeBytes = 0;
    let docCount = 0;
    for (const doc of raw) {
      const parsed = dataSizeDoc.safeParse(doc);
      if (parsed.success) {
        dataSizeBytes += parsed.data.storageStats.size;
        docCount += parsed.data.storageStats.count;
      }
    }
    return { dataSizeBytes, docCount };
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
    const shapes = new Map<
      string,
      {
        equality: string[];
        sort: SortKey[];
        range: string[];
        collscan: boolean;
        sortedInMemory: boolean;
        docsExamined: number;
        clients: QueryClient[];
        count: number;
        constants: Record<string, ConstantValue>;
        lookups: LookupJoin[];
      }
    >();
    for (const entry of profileDoc.array().parse(raw)) {
      let equality: string[] = [];
      let range: string[] = [];
      let sort: SortKey[] = [];
      let constants: Record<string, ConstantValue> = {};
      let lookups: LookupJoin[] = [];
      const filter = entry.command?.filter;
      if (filter !== undefined) {
        collectPredicates(filter, equality, range);
        sort = entry.command?.sort === undefined ? [] : sortKeysOf(entry.command.sort);
        // Profiler filters carry real literals — the partial-index signal.
        constants = equalityConstants(filter);
      } else if (entry.command?.pipeline !== undefined) {
        lookups = lookupJoins(entry.command.pipeline);
        const shape = pipelineShape(entry.command.pipeline);
        // A pipeline that gives an index nothing to serve can still carry a
        // $lookup — the foreign-side index signal survives as an empty shape.
        if (shape === null && lookups.length === 0) continue;
        if (shape !== null) ({ equality, range, sort } = { ...shape });
      } else {
        continue;
      }
      if (
        equality.length === 0 &&
        range.length === 0 &&
        sort.length === 0 &&
        lookups.length === 0
      ) {
        continue;
      }
      const key = shapeMapKey(equality, sort, range, lookups);
      const collscan = (entry.planSummary ?? "").includes("COLLSCAN");
      // A blocking SORT: the plan found its documents through an index but had
      // to order them in memory afterwards, because no index carried the sort.
      const sortedInMemory = entry.hasSortStage === true;
      // Same reasoning as the $queryStats path: work done at a prompt is not
      // workload, so it neither counts as a sighting nor accumulates cost.
      const client: QueryClient = entry.appName === undefined ? {} : { application: entry.appName };
      const interactive = classifyClient(client) === "INTERACTIVE";
      const countedDocs = interactive ? 0 : (entry.docsExamined ?? 0);
      const prev = shapes.get(key);
      if (prev === undefined) {
        shapes.set(key, {
          equality,
          sort,
          range,
          collscan,
          sortedInMemory,
          docsExamined: countedDocs,
          clients: [client],
          count: interactive ? 0 : 1,
          constants,
          lookups,
        });
      } else {
        prev.count += interactive ? 0 : 1;
        prev.docsExamined += countedDocs;
        // One profile document per execution, so unlike $queryStats (which
        // groups by client) the same client arrives over and over.
        if (!prev.clients.some((seen) => seen.application === client.application)) {
          prev.clients.push(client);
        }
        prev.collscan = prev.collscan || collscan;
        prev.sortedInMemory = prev.sortedInMemory || sortedInMemory;
        prev.constants = intersectConstants(prev.constants, constants);
      }
    }
    return [...shapes.values()].map((shape) => ({
      equality: shape.equality,
      sort: shape.sort,
      range: shape.range,
      collscan: shape.collscan,
      sortedInMemory: shape.sortedInMemory,
      count: shape.count,
      docsExamined: shape.docsExamined,
      clients: shape.clients,
      ...(Object.keys(shape.constants).length > 0 ? { constants: shape.constants } : {}),
      ...(shape.lookups.length > 0 ? { lookups: shape.lookups } : {}),
    }));
  }

  // Query shapes from $queryStats (mongo 6.0+): no profiler needed. COLLSCAN is
  // inferred from zero keys examined alongside docs examined. Requires
  // internalQueryStatsRateLimit != 0 on the server — it is 0 by default, so a
  // stock cluster has an empty store however privileged the credentials are.
  //
  // Before 8.0 the store reports execution counts and timings only: no
  // `keysExamined`, no `docsExamined`, no `hasSortStage`. Every shape would
  // therefore look non-scanning, which is not "no findings" but "cannot tell" —
  // and returning those shapes would suppress the profiler fallback and with it
  // every create recommendation the cluster could have had. So a store without
  // plan metrics reports nothing and lets the profiler answer instead.
  async collectQueryStats(targets: readonly WorkloadTarget[]): Promise<Map<string, QueryShape[]>> {
    if (targets.length === 0) return new Map();
    // ONE read of the store for the whole cluster. It holds an entry per
    // distinct query shape the server has seen, so reading it per collection
    // costs the full store times the collection count.
    const raw = await this.conn
      .db("admin")
      .aggregate([{ $queryStats: {} }])
      .toArray();
    const byNamespace = new Map<string, QueryShape[]>();
    const wanted = new Set(targets.map((t) => workloadKey(t.database, t.collection)));
    const shapes = new Map<
      string,
      {
        namespace: string;
        docsExamined: number;
        clients: QueryClient[];
        equality: string[];
        sort: SortKey[];
        range: string[];
        collscan: boolean;
        sortedInMemory: boolean;
        count: number;
        lookups: LookupJoin[];
      }
    >();
    const entries = raw.flatMap((doc) => {
      const parsed = queryStatsDoc.safeParse(doc);
      return parsed.success ? [parsed.data] : [];
    });
    // Server-wide capability, so any one entry answers it. An empty store says
    // nothing either way and falls through to the same empty result.
    if (!entries.some((entry) => entry.metrics.keysExamined !== undefined)) return new Map();
    for (const { key, metrics } of entries) {
      const namespace = workloadKey(key.queryShape.cmdNs.db, key.queryShape.cmdNs.coll);
      if (!wanted.has(namespace)) continue;
      let equality: string[] = [];
      let range: string[] = [];
      let sort: SortKey[] = [];
      let lookups: LookupJoin[] = [];
      const filter = key.queryShape.filter;
      if (filter !== undefined) {
        collectPredicates(filter, equality, range);
        sort = key.queryShape.sort === undefined ? [] : sortKeysOf(key.queryShape.sort);
      } else if (key.queryShape.pipeline !== undefined) {
        lookups = lookupJoins(key.queryShape.pipeline);
        const shape = pipelineShape(key.queryShape.pipeline);
        if (shape === null && lookups.length === 0) continue;
        if (shape !== null) ({ equality, range, sort } = { ...shape });
      } else {
        continue;
      }
      if (
        equality.length === 0 &&
        range.length === 0 &&
        sort.length === 0 &&
        lookups.length === 0
      ) {
        continue;
      }
      // Work done BY THIS CLIENT. Attributed below only when the client is not
      // a person at a prompt: shapes merge across clients (the key is the shape
      // and namespace, not the client), so otherwise a developer running the
      // same query the app runs inflates both the execution count that gates
      // instant apply and the examined-document count that drives severity.
      const docsExamined = metrics.docsExamined?.sum ?? 0;
      const client: QueryClient = {
        ...(key.client?.application?.name === undefined
          ? {}
          : { application: key.client.application.name }),
        ...(key.client?.driver?.name === undefined ? {} : { driver: key.client.driver.name }),
      };
      const collscan = (metrics.keysExamined?.sum ?? 0) === 0 && docsExamined > 0;
      // An index found the documents but none could order them, so the server
      // sorted in memory. Invisible to the collscan test — keys were examined.
      const sortedInMemory = (metrics.hasSortStage?.true ?? 0) > 0;
      const interactive = classifyClient(client) === "INTERACTIVE";
      const countedExecs = interactive ? 0 : metrics.execCount;
      const countedDocs = interactive ? 0 : docsExamined;
      // Shapes are deduplicated per namespace, not globally — the same filter
      // shape against two collections is two different findings.
      const mapKey = `${namespace}\u0000${shapeMapKey(equality, sort, range, lookups)}`;
      const prev = shapes.get(mapKey);
      if (prev === undefined) {
        shapes.set(mapKey, {
          namespace,
          docsExamined: countedDocs,
          clients: [client],
          equality,
          sort,
          range,
          collscan,
          sortedInMemory,
          count: countedExecs,
          lookups,
        });
      } else {
        prev.count += countedExecs;
        prev.docsExamined += countedDocs;
        prev.clients.push(client);
        prev.collscan = prev.collscan || collscan;
        prev.sortedInMemory = prev.sortedInMemory || sortedInMemory;
      }
    }
    for (const shape of shapes.values()) {
      const list = byNamespace.get(shape.namespace) ?? [];
      list.push({
        equality: shape.equality,
        sort: shape.sort,
        range: shape.range,
        collscan: shape.collscan,
        sortedInMemory: shape.sortedInMemory,
        count: shape.count,
        docsExamined: shape.docsExamined,
        clients: shape.clients,
        ...(shape.lookups.length > 0 ? { lookups: shape.lookups } : {}),
      });
      byNamespace.set(shape.namespace, list);
    }
    return byNamespace;
  }

  // Server-wide counters describing what the query engine is doing. Needs the
  // `serverStatus` action; without it this returns null and the five-minute
  // probe falls back to per-collection latency alone.
  async collectServerHealth(): Promise<ServerHealth | null> {
    try {
      const raw: unknown = await this.conn.db("admin").command({ serverStatus: 1 });
      const parsed = serverStatusDoc.safeParse(raw);
      if (!parsed.success) return null;
      const { metrics, globalLock, mem } = parsed.data;
      return {
        collectionScans: metrics.queryExecutor.collectionScans?.total ?? 0,
        scannedObjects: metrics.queryExecutor.scannedObjects,
        scannedKeys: metrics.queryExecutor.scanned,
        scanAndOrder: metrics.operation?.scanAndOrder ?? 0,
        queuedReaders: globalLock?.currentQueue?.readers ?? 0,
        queuedWriters: globalLock?.currentQueue?.writers ?? 0,
        residentMb: mem?.resident ?? 0,
      };
    } catch {
      return null;
    }
  }

  // Indexes the application names explicitly with hint().
  //
  // A hinted index cannot be hidden: mongod rejects a hint at a hidden index
  // outright (BadValue), so the observe stage would BREAK those queries rather
  // than slow them — and the regression gate measures latency, so it would see
  // nothing and let the drop through. $queryStats does not record hints at all;
  // the profiler does, which makes it the only source for this.
  //
  // Only the profiler window is visible here, so absence is not proof. It is a
  // one-way signal: a hint seen means hands off, a hint unseen means nothing.
  async collectHintedIndexes(database: string, collection: string): Promise<string[]> {
    const ns = `${database}.${collection}`;
    const raw = await this.conn
      .db(database)
      .collection("system.profile")
      .find({ ns })
      .toArray()
      .catch(() => []);
    const named = new Set<string>();
    const patterns: Record<string, unknown>[] = [];
    for (const doc of raw) {
      const parsed = profileDoc.safeParse(doc);
      if (!parsed.success) continue;
      const hint = parsed.data.command?.hint;
      if (typeof hint === "string") named.add(hint);
      else if (isRecord(hint)) patterns.push(hint);
    }
    // A key-pattern hint ({b: 1}) names an index by shape, so it has to be
    // matched against the real index list to get a name.
    if (patterns.length > 0) {
      const specs = await this.listIndexes(database, collection).catch(() => []);
      for (const pattern of patterns) {
        const fields = Object.keys(pattern);
        for (const spec of specs) {
          const keys = spec.keys.map((key) => key.field);
          if (keys.length === fields.length && keys.every((f, i) => fields[i] === f)) {
            named.add(spec.name);
          }
        }
      }
    }
    return [...named];
  }

  // Recurring age-based deletes ({field: {$lt: <date>}}) from the profiler —
  // the strong TTL-advisory signal. Retention = delete time minus its cutoff.
  async collectDeletePatterns(database: string, collection: string): Promise<DeletePattern[]> {
    const ns = `${database}.${collection}`;
    const raw = await this.conn
      .db(database)
      .collection("system.profile")
      .find({ ns, op: "remove" })
      .toArray();
    const samples = new Map<string, number[]>();
    for (const doc of raw) {
      const parsed = profileDoc.safeParse(doc);
      if (!parsed.success) continue;
      const entry = parsed.data;
      const q = entry.command?.q;
      if (q === undefined || entry.ts === undefined) continue;
      const range = dateRangeCutoff(q);
      if (range === null) continue;
      const retentionSeconds = (entry.ts.getTime() - range.cutoff.getTime()) / 1000;
      if (retentionSeconds <= 0) continue;
      const list = samples.get(range.field) ?? [];
      list.push(retentionSeconds);
      samples.set(range.field, list);
    }
    return [...samples.entries()].map(([field, retentions]) => ({
      field,
      count: retentions.length,
      medianRetentionSeconds: Math.round(median(retentions)),
    }));
  }

  // Preferred workload source: $queryStats, falling back to the profiler when
  // it is unavailable (mongo <7, disabled, missing permission) or has nothing
  // for a given namespace. The fallback stays per namespace: $queryStats can
  // answer for one collection and not another.
  async collectWorkload(
    targets: readonly WorkloadTarget[],
  ): Promise<Map<string, readonly QueryShape[]>> {
    let fromStats = new Map<string, QueryShape[]>();
    try {
      fromStats = await this.collectQueryStats(targets);
    } catch {
      // Store unavailable for the whole cluster — every namespace falls back.
    }
    const out = new Map<string, readonly QueryShape[]>();
    for (const target of targets) {
      const key = workloadKey(target.database, target.collection);
      const shapes = fromStats.get(key) ?? [];
      out.set(
        key,
        shapes.length > 0
          ? shapes
          : await this.collectSlowQueries(target.database, target.collection),
      );
    }
    return out;
  }
}
