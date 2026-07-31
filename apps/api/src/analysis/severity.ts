import type { QueryShape } from "./workload";

// How much a missing index is actually costing.
//
// Collection size was the only input before, through a single 10,000-document
// gate. That says how big the table is, not how much work is being wasted: a
// shape scanning a 50M-document collection twice a day and one scanning 1,001
// documents a thousand times an hour both cleared the same bar and were treated
// identically.
//
// `$queryStats` has reported the real number all along — `docsExamined`, the
// documents the server actually walked for this shape — and nothing read it.
// That is the measure: total work wasted, not table size and not frequency,
// because either alone is misleading.

export type ScanSeverity = "CRITICAL" | "ELEVATED" | "ROUTINE";

// Total documents walked before an index would have been proposed. Ten million
// is roughly "this is showing up in someone's latency graphs"; one million is
// worth prioritising but not worth an unscheduled build.
const CRITICAL_DOCS_EXAMINED = 10_000_000;
const ELEVATED_DOCS_EXAMINED = 1_000_000;
// A collection this size makes a scan expensive per execution regardless of how
// often it has run so far — raised from 10,000, which in 2026 is a small table
// that a scan barely notices.
const LARGE_COLLECTION_DOCS = 100_000;
// A single execution walking this many documents is severe on its own, even if
// the shape is new and the running total is still small.
const CRITICAL_DOCS_PER_EXECUTION = 500_000;

export interface ScanCost {
  readonly severity: ScanSeverity;
  // Documents walked in total, as far as the workload source can see. Zero when
  // the source did not report it (the profiler does not).
  readonly docsExamined: number;
  // Human-readable, for the recommendation's rationale.
  readonly summary: string;
}

function round(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

// Severity of the scan this shape is doing. `docCount` is the collection's size,
// used as the fallback signal when the workload source cannot report examined
// documents — the profiler path, and any $queryStats entry predating the field.
export function scanCost(shape: QueryShape, docCount: number): ScanCost {
  if (!shape.collscan) {
    return { severity: "ROUTINE", docsExamined: 0, summary: "not scanning" };
  }
  const examined = shape.docsExamined ?? 0;
  const perExecution = shape.count > 0 ? examined / shape.count : 0;

  if (examined >= CRITICAL_DOCS_EXAMINED || perExecution >= CRITICAL_DOCS_PER_EXECUTION) {
    return {
      severity: "CRITICAL",
      docsExamined: examined,
      summary:
        `${round(examined)} documents scanned across ${shape.count} executions ` +
        `(~${round(perExecution)} per query)`,
    };
  }
  if (examined >= ELEVATED_DOCS_EXAMINED || docCount >= LARGE_COLLECTION_DOCS) {
    return {
      severity: "ELEVATED",
      docsExamined: examined,
      summary:
        examined > 0
          ? `${round(examined)} documents scanned across ${shape.count} executions`
          : `scanning a collection of ${round(docCount)} documents`,
    };
  }
  return {
    severity: "ROUTINE",
    docsExamined: examined,
    summary: `scanning a collection of ${round(docCount)} documents`,
  };
}

// A CRITICAL scan is an ongoing cost being paid on every execution. Waiting for
// the quiet window can mean most of a day of it, which is worse than building
// the index at an inconvenient hour — so this is the one create that does not
// wait. ELEVATED and below keep the window.
export function bypassesChangeWindow(severity: ScanSeverity): boolean {
  return severity === "CRITICAL";
}
