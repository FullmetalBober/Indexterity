// Server-wide distress, and whether an index would help with it.
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
// missing index, and nothing else.

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

export type HealthSeverity = "CRITICAL" | "ELEVATED" | "HEALTHY";

export interface HealthVerdict {
  readonly severity: HealthSeverity;
  // Whether the pressure is the kind an index can relieve. A queue full of
  // writers is not.
  readonly indexRelated: boolean;
  readonly summary: string;
}

export interface HealthOptions {
  // Collection scans in the interval before it is worth reacting.
  readonly minScans: number;
  // Documents walked per index key. A healthy workload reads a handful of
  // documents per key; a scanning one reads thousands.
  readonly criticalDocsPerKey: number;
  readonly elevatedDocsPerKey: number;
  // Readers queued behind the global lock — the database is actively behind.
  readonly criticalQueuedReaders: number;
}

export const DEFAULT_HEALTH: HealthOptions = {
  minScans: 50,
  criticalDocsPerKey: 1000,
  elevatedDocsPerKey: 100,
  criticalQueuedReaders: 10,
};

function round(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

// Compare two readings taken a few minutes apart. Cumulative counters give the
// interval's work; the queue depths are read from the newer sample as-is.
export function assessHealth(
  before: ServerHealth,
  after: ServerHealth,
  options: HealthOptions = DEFAULT_HEALTH,
): HealthVerdict {
  const scans = after.collectionScans - before.collectionScans;
  const docs = after.scannedObjects - before.scannedObjects;
  const keys = after.scannedKeys - before.scannedKeys;
  const sorts = after.scanAndOrder - before.scanAndOrder;

  // Any negative delta means the server restarted between readings; the
  // interval covers an unknown amount of work, so it is not evidence.
  if (scans < 0 || docs < 0 || keys < 0 || sorts < 0) {
    return { severity: "HEALTHY", indexRelated: false, summary: "counters reset" };
  }

  // Queued readers mean the database is behind NOW, whatever the cause. Worth
  // reporting even when an index is not the answer.
  if (after.queuedReaders >= options.criticalQueuedReaders) {
    return {
      severity: "CRITICAL",
      indexRelated: scans >= options.minScans,
      summary:
        `${after.queuedReaders} reads queued behind the global lock` +
        (scans >= options.minScans ? `, with ${round(scans)} collection scans in the window` : ""),
    };
  }

  if (scans < options.minScans) {
    return { severity: "HEALTHY", indexRelated: false, summary: "no significant scanning" };
  }

  // Documents walked per index key: the shape of the work, independent of
  // volume. Keys of zero means nothing used an index at all.
  const docsPerKey = keys > 0 ? docs / keys : docs;
  const detail =
    `${round(scans)} collection scans walking ${round(docs)} documents` +
    (sorts > 0 ? `, ${round(sorts)} sorts without an index` : "");

  if (docsPerKey >= options.criticalDocsPerKey) {
    return { severity: "CRITICAL", indexRelated: true, summary: detail };
  }
  if (docsPerKey >= options.elevatedDocsPerKey) {
    return { severity: "ELEVATED", indexRelated: true, summary: detail };
  }
  return { severity: "HEALTHY", indexRelated: false, summary: "scanning within normal bounds" };
}
