// The vocabulary the ports are written in.
//
// These are the shapes an adapter PRODUCES: what an index is, what a distinct
// query shape looks like, and what server-wide distress reads as. Every one of
// them appears in a signature in ports.ts, so they are part of the contract a
// new adapter is written against rather than internals of the analysis core
// that consumes them.
//
// They used to live under analysis/, which put engine/ports.ts — the file that
// calls itself the engine-neutral boundary — in a cycle with the layer above
// it, and meant an adapter could not be read without reading that layer (#330).
// Nothing here may import from analysis/; that is the whole point of the file.
//
// Vocabulary is MongoDB-flavored on purpose, for the reason given in ports.ts.

export type IndexDirection = 1 | -1 | "2dsphere" | "text" | "hashed";

export interface IndexKey {
  readonly field: string;
  readonly direction: IndexDirection;
}

// Normalized view of a MongoDB index plus the options that affect safety.
// collation = the locale string, or null for the default binary comparison —
// two same-key indexes under different collations serve DIFFERENT queries.
export interface IndexSpec {
  readonly name: string;
  readonly keys: readonly IndexKey[];
  readonly unique: boolean;
  readonly ttl: boolean;
  readonly partial: boolean;
  // The actual partialFilterExpression, not just whether there is one. Two
  // partial indexes are only interchangeable if they filter on the same thing,
  // and a boolean cannot say that. Null for a full index, and for specs
  // persisted before this was captured.
  readonly partialFilter: Readonly<Record<string, unknown>> | null;
  readonly sparse: boolean;
  readonly hidden: boolean;
  readonly isShardKey: boolean;
  readonly collation: string | null;
  // Columns the index carries at its leaves without ordering by them — SQL
  // Server's INCLUDE. They are not part of the key, so they change nothing
  // about what the index can SEEK; what they change is what it can ANSWER
  // without going back to the table, which is exactly what makes an index
  // covering. Two indexes with the same keys and different includes serve
  // different queries.
  //
  // Absent for engines that have no such concept (MongoDB indexes every key
  // they name and nothing else), which is why it is optional rather than an
  // empty array everywhere: a spec that never had includes and one whose
  // includes were not captured are the same thing to every reader here.
  readonly include?: readonly string[] | undefined;
}

// One client as the workload source describes it.
//
// `$queryStats` groups by client as well as by shape, so the same `find` issued
// from a shell and from an application server are already separate entries —
// each carrying the connecting client's application and driver name. What that
// signal is FOR, and how a name is read, is analysis/client.ts.
export interface QueryClient {
  // From the connection string's appName, or the driver's default.
  readonly application?: string;
  readonly driver?: string;
}

export interface SortKey {
  readonly field: string;
  readonly direction: 1 | -1;
}

// A primitive an equality predicate compared against in EVERY sample of a
// shape — the signal for a partial index. Only the profiler carries real
// values ($queryStats shapifies them away), so this is often empty.
export type ConstantValue = string | number | boolean;

// A $lookup join observed in an aggregation: the foreign collection and the
// field it is joined on — the signal for a foreign-side index.
export interface LookupJoin {
  readonly from: string;
  readonly foreignField: string;
}

// A distinct query pattern from $queryStats/the profiler, split for the ESR
// rule: equality predicates, then sort keys (with directions), then ranges.
export interface QueryShape {
  readonly equality: readonly string[];
  readonly sort: readonly SortKey[];
  readonly range: readonly string[];
  readonly collscan: boolean;
  // The plan found its documents through an index but could not order them, so
  // the server buffered the result and sorted it in memory. A missing index in
  // its own right, and one `collscan` can never show: keys WERE examined, so by
  // every scan test the query looks healthy. It is also the failure mode that
  // ends in an error rather than slowness — a blocking sort dies at 100 MB.
  readonly sortedInMemory?: boolean;
  readonly count: number;
  // Documents the server actually walked for this shape. The measure of what a
  // missing index is costing — see analysis/severity.ts. Reported by the
  // profiler, and by `$queryStats` from mongo 8.0 (earlier stores carry
  // execution counts only).
  readonly docsExamined?: number | undefined;
  // How long this shape has been watchable, in hours — the denominator that
  // turns `count` into a rate. $queryStats reports when it first saw each shape;
  // the profiler's capped ring reports how far back it still holds entries.
  // Absent when the source cannot say, which is not the same as zero.
  readonly observedForHours?: number | undefined;
  // Who issued this shape. $queryStats groups by client as well as by shape,
  // so a query run from a shell and the same query from an app arrive as
  // separate entries; merged shapes accumulate every client seen. The profiler
  // reports `appName`, which lands here the same way.
  readonly clients?: readonly QueryClient[];
  readonly constants?: Readonly<Record<string, ConstantValue>> | undefined;
  // $lookup joins anywhere in the pipeline (indexed on the FOREIGN collection).
  readonly lookups?: readonly LookupJoin[];
}

// Server-wide distress, as the adapter reads it off the server.
//
// The obvious metric is CPU, and mongod does not report it: `serverStatus` has
// no `systemMetrics` outside FTDC (verified on 8.2). What it does report is far
// more to the point, because these counters describe the work the query engine
// is doing rather than how hot the box is:
//
//   collectionScans   how many collection scans have run
//   scannedObjects    documents walked
//   scanned           index keys walked
//   scanAndOrder      sorts performed without an index to order by
//   currentQueue      operations queued behind the global lock, right now
//
// A loaded CPU could be a backup, a batch job or a noisy neighbour. Collection
// scans climbing while documents-walked-per-index-key climbs with them is a
// missing index, and nothing else. What the other two engines map onto each of
// these, and what a reading MEANS, is analysis/health.ts.
export interface ServerHealth {
  // All cumulative since the server started.
  readonly collectionScans: number;
  readonly scannedObjects: number;
  readonly scannedKeys: number;
  readonly scanAndOrder: number;
  // Instantaneous, not cumulative.
  readonly queuedReaders: number;
  readonly queuedWriters: number;
  readonly residentMb: number;
}
