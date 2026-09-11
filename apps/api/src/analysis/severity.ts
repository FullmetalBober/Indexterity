import type { QueryShape } from "../engine/types";
import { executionsPerWeek } from "./workload";

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
// The floor for looking at a collection's queries at all, as an ongoing rate.
//
// Total-walked answers "how bad has this been"; a rate answers "is it still
// happening", which is the question eligibility asks. A million documents a
// week is roughly where an index starts paying for the write it adds to every
// insert. Measured this way both mistakes a document-count gate makes go away
// at once: a 900-document collection scanned five hundred times a second is 270
// billion a week and no longer invisible, and a 50,000-row lookup table scanned
// twice a day is 700k and no longer worth an index.
export const MIN_WEEKLY_DOCS_EXAMINED = 1_000_000;

// What it takes before a PER-WEEK figure is allowed to be one (#509).
//
// `executionsPerWeek` divides a pass's execution count by the window that pass
// observed, which is a sound rate estimate — `system.profile` is a capped ring,
// so a full ring reaching back three minutes really does imply a high rate. What
// it is not is a claim about a WEEK, and the workload page both ranks by and
// prints the result as one.
//
// Measured on the hosted deployment: `msb-app.exercise-tags` ranked THIRD in the
// customer's most-expensive-queries list at 163 million documents a week, from a
// row two hours old, confirmed three times, on ONE execution. `msb-app.comment`
// showed 32 million a week from a single sighting. 33 of 202 shapes carrying a
// weekly figure had been watched for under a day or confirmed fewer than twelve
// times; two of them were in the page's top ten.
//
// So the projection needs evidence that the shape RECURS, which is a different
// question from how fast it ran while we were looking, and the answer is already
// stored: `observations` and the span from `first_seen_at` to `last_seen_at`.
//
// A day, because it is the shortest span that contains a whole daily cycle — a
// shape that only runs overnight is still seen — and twelve confirmations,
// because the passes that write this table are hourly, so that is half a day of
// them and it excludes the three-sighting rows above. Both are floors on OUR
// evidence, deliberately not on the source's observation window: that window is
// the ring's reach, its median here is 2.2 hours, and any floor on it would
// discard the genuinely busy shapes this is meant to keep.
export const MIN_PROJECTION_OBSERVATIONS = 12;
export const MIN_PROJECTION_LIFETIME_HOURS = 24;

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

// What this collection's scans cost per week, in documents walked.
//
// The same measure `scanCost` grades, expressed as a rate so it can be compared
// against a floor rather than against the collection's size. Summed across
// shapes: a collection is worth analysing when its scanning adds up, not only
// when one shape is bad on its own.
//
// Where the source reports no `docsExamined` — `$queryStats` below 8.0, and any
// entry predating the field — a collection scan walks the whole collection by
// definition, so the collection size is the per-execution figure. It is the
// arithmetic a document-count gate was standing in for all along: cost is
// documents TIMES frequency, and a gate on documents alone knows half of it.
// The estimate is also the ceiling, so a missing figure errs towards analysing
// the collection rather than towards ignoring it.
export function weeklyScanCost(shapes: readonly QueryShape[], docCount: number): number {
  let total = 0;
  for (const shape of shapes) {
    if (!shape.collscan) continue;
    const examined = shape.docsExamined ?? shape.count * docCount;
    const perExecution = shape.count > 0 ? examined / shape.count : 0;
    total += perExecution * executionsPerWeek(shape);
  }
  return total;
}

// A CRITICAL scan is an ongoing cost being paid on every execution. Waiting for
// the quiet window can mean most of a day of it, which is worse than building
// the index at an inconvenient hour — so this is the one create that does not
// wait. ELEVATED and below keep the window.
export function bypassesChangeWindow(severity: ScanSeverity): boolean {
  return severity === "CRITICAL";
}
