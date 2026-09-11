import { beginPhase, timePhase } from "../engine/phases";
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
  // How many of `readOps` this product caused — see mongo/self-reads.ts. Zero on
  // an engine that measures a table without reading it, which is every engine
  // but MongoDB.
  readonly selfReadOps: number;
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
  // Timed per boundary (#466). Aggregated by phase NAME across databases, so
  // thirteen `latencyByCollection` calls read as one cost rather than thirteen
  // lines — and so an abandoned pass can name which of these was the slow one
  // instead of only that it stopped. A no-op outside a pass.
  const databases = await timePhase("listDatabaseNames", () => session.listDatabaseNames());
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
      collections = await timePhase("listCollectionNames", () =>
        collector.listCollectionNames(database),
      );
    } catch (error) {
      if (error instanceof DatabaseInaccessibleError) continue;
      throw error;
    }
    // Latency and hints once per database where the engine offers that (#454):
    // on SQL Server the per-table read was a whole-Query-Store scan, twice per
    // table. Elsewhere the per-collection reads below are the cheap ones.
    //
    // Bound rather than called through the optional member, because the
    // narrowing does not survive into the closure `timePhase` takes — and a
    // method called off a detached reference would lose its `this`.
    const readLatency = collector.latencyByCollection?.bind(collector);
    const readHints = collector.hintedByCollection?.bind(collector);
    const latencies =
      readLatency === undefined
        ? null
        : await timePhase("latencyByCollection", () => readLatency(database));
    const hints =
      readHints === undefined
        ? null
        : await timePhase("hintedByCollection", () => readHints(database, collections));
    // The three CATALOG reads on the same terms (#461). Same shape as the two
    // above deliberately: a batched read if the engine has one, the
    // per-collection read if it does not, and an absent entry means the
    // collection has no rowstore indexes.
    //
    // These are the reads that made a collect cost its round trips. Query Store
    // was two scans per table and #454 fixed that; this was three statements per
    // table, which is cheap on a local socket and is the whole budget on a
    // cluster reached through a tunnel — 1,086 of them on the hosted
    // deployment's 362-table cluster, whose collect then stopped fitting in five
    // minutes and stayed broken for 19 hours.
    const readSpecs = collector.indexesByCollection?.bind(collector);
    const readUsage = collector.usageByCollection?.bind(collector);
    const readSizes = collector.indexSizesByCollection?.bind(collector);
    const allSpecs =
      readSpecs === undefined
        ? null
        : await timePhase("indexesByCollection", () => readSpecs(database));
    const allUsage =
      readUsage === undefined
        ? null
        : await timePhase("usageByCollection", () => readUsage(database));
    const allSizes =
      readSizes === undefined
        ? null
        : await timePhase("indexSizesByCollection", () => readSizes(database));
    // One phase for the whole loop, not one per collection: on an engine with
    // the batched reads above this is map lookups, and on one without it is the
    // per-collection reads — either way what a reader wants is the total, and
    // 362 phases named after tables would be a report nobody finishes.
    const perCollection = beginPhase("per-collection");
    for (const collection of collections) {
      const [specs, usage, sizes, hinted] = await Promise.all([
        allSpecs === null
          ? collector.listIndexes(database, collection)
          : Promise.resolve(allSpecs.get(collection) ?? []),
        allUsage === null
          ? collector.collectUsage(database, collection)
          : Promise.resolve(allUsage.get(collection) ?? []),
        allSizes === null
          ? collector.indexSizes(database, collection)
          : Promise.resolve(allSizes.get(collection) ?? {}),
        hints === null
          ? collector.collectHintedIndexes(database, collection).catch(() => [])
          : Promise.resolve(hints.get(collection) ?? []),
      ]);
      // The latency sample goes LAST, and on its own, which is the difference
      // between a fold that works and one that works about half the time (#502).
      //
      // The run's identity is `readOps - selfReadOps` (jobs/runs.ts), and that
      // is only stable across two passes if the number of our own reads issued
      // AFTER the sample is the same both times. Inside the `Promise.all` above
      // it is not: five requests are in flight together and which of them land
      // after the sample is decided by response ordering. #518 shipped exactly
      // that and `dev` went red on two of three MongoDB versions while the third
      // passed.
      //
      // Sampling last makes that number zero by construction. It costs one extra
      // SEQUENTIAL round trip per collection — the cost #454 and #461 are about —
      // and it is affordable here for a reason worth stating rather than
      // assuming: only MongoDB reaches this branch. SQL Server implements
      // `latencyByCollection` and takes the batched path above, and SQL Server is
      // the engine behind the tunnel where round trips are dear.
      const collLatency =
        latencies === null
          ? await collector.collectionLatency(database, collection)
          : (latencies.get(collection) ?? NO_ACTIVITY);
      const hintedNames = new Set(hinted);
      latency.push({
        database,
        collection,
        readOps: collLatency.reads.ops,
        readLatencyMicros: collLatency.reads.latencyMicros,
        writeOps: collLatency.writes.ops,
        writeLatencyMicros: collLatency.writes.latencyMicros,
        // Filled in below, once the pass has finished reading this namespace.
        selfReadOps: 0,
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
    // Ended here rather than in a `finally`: a throw out of the loop takes the
    // whole pass with it, and `runClusterTask` reads the phases off the registry
    // itself — an unended phase is simply one the report leaves out, which is
    // honest about a loop that never finished.
    perCollection();
  }
  // Our own reads, counted once the pass is DONE reading — not at the moment
  // each sample was taken.
  //
  // A sample is taken part-way through a namespace's reads (they run as one
  // `Promise.all`), so an interval between two samples holds the tail of one
  // pass, whatever ran between them, and the head of the next. Reading the tally
  // after the pass puts the WHOLE of the later pass on one side of that boundary
  // and none of the earlier one — the same quantity, as long as each pass issues
  // the same calls per namespace. Which is what makes the ordering inside the
  // `Promise.all` irrelevant instead of a race to lose. See mongo/self-reads.ts.
  const selfReads = collector.selfReadOps?.bind(collector);
  return {
    snapshots,
    latency:
      selfReads === undefined
        ? latency
        : latency.map((sample) => ({
            ...sample,
            selfReadOps: selfReads(sample.database, sample.collection),
          })),
  };
}
