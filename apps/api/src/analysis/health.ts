import type { ServerHealth } from "../engine/types";

// What a ServerHealth reading MEANS: whether the server is in distress, and
// whether it is the kind of distress an index can relieve.
//
// The counters themselves are the adapter's business and are described where
// they are declared (engine/types.ts). What lives here is the judgement — the
// thresholds, the per-engine wording, and the one sentence a human reads.

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
  // Blocking in-memory sorts in the interval, judged on their own rather than
  // as a footnote to scanning. A query can find its documents through an index
  // and still sort them by hand, which moves no scan counter at all — so a
  // server doing nothing but unindexed sorts would otherwise read as healthy,
  // and it is the one failure mode that ends in an error rather than slowness.
  readonly criticalSorts: number;
  readonly elevatedSorts: number;
  // What the counters COUNT, for the one sentence a human reads.
  //
  // This repo's rule is that the vocabulary stays MongoDB-flavoured and a
  // relational adapter maps it (engine/ports.ts) — "collection" for a table is a
  // mapping a reader makes without help. A UNIT is not: SQL Server's analogue of
  // documents-walked is buffer-pool page lookups, and "2.7M documents" about a
  // 300k-row table is not flavour, it is a wrong number that a DBA would rightly
  // stop trusting the rest of the finding over. Measured: that exact summary
  // came out of the first end-to-end run.
  readonly wording: HealthWording;
}

export interface HealthWording {
  // "collection scans" / "table scans"
  readonly scans: string;
  // "documents" / "pages"
  readonly walked: string;
  // "sorts without an index" / "sorts spilled to tempdb"
  readonly sorts: string;
  // What the queued readers are queued BEHIND. Mongo's number comes from
  // globalLock.currentQueue and there is a global lock to name; SQL Server's
  // comes from the waiting-task DMV, where a reader is waiting on the specific
  // shared lock or page latch it asked for, and there is no global lock at all.
  readonly queue: string;
}

// Tuned for the probe's five-second sampling gap (jobs/probe.ts). The sort
// thresholds are deliberately well above what an ordinary busy server does —
// firing means running the whole workload pass, so it should mean a real burst
// (~50/s elevated, ~500/s critical), not a handful of small sorts.
export const DEFAULT_HEALTH: HealthOptions = {
  minScans: 50,
  criticalDocsPerKey: 1000,
  elevatedDocsPerKey: 100,
  criticalQueuedReaders: 10,
  criticalSorts: 2500,
  elevatedSorts: 250,
  wording: {
    scans: "collection scans",
    walked: "documents",
    sorts: "sorts without an index",
    queue: "reads queued behind the global lock",
  },
};

// SQL Server reports the same five things, and three of them count something
// different enough that the numbers above would be wrong (#205). The counters
// themselves are in mssql/health.ts; these are what the readings mean.
//
//   docsPerKey  is `Page lookups / Index Searches` — pages touched per index
//               search rather than documents per key. The healthy floor is the
//               b-tree DESCENT, measured at 3.01 on a seeking workload and
//               therefore flat as a table grows, against 66.6 when full scans
//               dominated the same table. So mongo's 100/1000 would never fire:
//               20 is already "a fifth of the work is scanning" and 200 is
//               "scanning is all this server is doing".
//   sorts       is `Workfiles Created/sec`, which counts a SPILL to tempdb, not
//               an in-memory sort. It is a strictly worse event than the one
//               mongo's scanAndOrder counts and a much rarer one — zero movement
//               across every non-spilling seek and scan loop measured, against
//               +3990 for a single deliberately starved 300k-row sort. Mongo's
//               250/2500 would mean a server that had spilled dozens of large
//               sorts before anyone looked.
//   minScans    is doubled, because `Full Scans/sec` counts a full scan of a
//               three-row lookup table exactly as it counts one of a million-row
//               fact table, and OLTP does the former constantly. The ratio gate
//               is what carries the judgement; this is only a floor.
//
// criticalQueuedReaders is unchanged at 10, and deliberately: the reading is
// directly comparable — readers queued behind a lock they cannot take, right
// now — and ten of them means the same thing on either engine.
export const MSSQL_HEALTH: HealthOptions = {
  minScans: 100,
  criticalDocsPerKey: 200,
  elevatedDocsPerKey: 20,
  criticalQueuedReaders: 10,
  criticalSorts: 500,
  elevatedSorts: 20,
  wording: {
    scans: "table scans",
    walked: "pages",
    sorts: "sorts spilled to tempdb",
    queue: "reads waiting on a lock or page latch",
  },
};

// The more serious of two readings of the same interval.
function worse(a: HealthSeverity, b: HealthSeverity): HealthSeverity {
  if (a === "CRITICAL" || b === "CRITICAL") return "CRITICAL";
  if (a === "ELEVATED" || b === "ELEVATED") return "ELEVATED";
  return "HEALTHY";
}

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

  // Documents walked per index key: the shape of the work, independent of
  // volume. Keys of zero means nothing used an index at all. Below minScans
  // there is no scanning worth judging.
  const docsPerKey = keys > 0 ? docs / keys : docs;
  const scanning: HealthSeverity =
    scans < options.minScans
      ? "HEALTHY"
      : docsPerKey >= options.criticalDocsPerKey
        ? "CRITICAL"
        : docsPerKey >= options.elevatedDocsPerKey
          ? "ELEVATED"
          : "HEALTHY";
  const sorting: HealthSeverity =
    sorts >= options.criticalSorts
      ? "CRITICAL"
      : sorts >= options.elevatedSorts
        ? "ELEVATED"
        : "HEALTHY";
  const indexRelated = scanning !== "HEALTHY" || sorting !== "HEALTHY";

  // Queued readers mean the database is behind NOW, whatever the cause. Worth
  // reporting even when an index is not the answer.
  if (after.queuedReaders >= options.criticalQueuedReaders) {
    return {
      severity: "CRITICAL",
      indexRelated,
      summary:
        `${after.queuedReaders} ${options.wording.queue}` +
        (scans >= options.minScans
          ? `, with ${round(scans)} ${options.wording.scans} in the window`
          : ""),
    };
  }

  const severity = worse(scanning, sorting);
  if (severity === "HEALTHY") {
    return {
      severity,
      indexRelated: false,
      summary:
        scans < options.minScans ? "no significant scanning" : "scanning within normal bounds",
    };
  }

  // Name only what actually contributed: a sort burst on an otherwise quiet
  // server should not be reported as a scan problem.
  const parts: string[] = [];
  if (scans >= options.minScans) {
    parts.push(
      `${round(scans)} ${options.wording.scans} walking ${round(docs)} ${options.wording.walked}`,
    );
  }
  if (sorts > 0) parts.push(`${round(sorts)} ${options.wording.sorts}`);
  return { severity, indexRelated, summary: parts.join(", ") };
}
