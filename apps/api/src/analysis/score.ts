import type { UsageClass } from "@repo/contracts";
import type { ScanSeverity } from "./severity";

// Confidence scoring (0–100). The score gates pipeline ENTRY — what gets
// proposed and what auto-approves — never the safety stages: an auto-approved
// drop still goes hide → observe → regression/pre-flight gates before deletion.
//
// The scale is calibrated so 100 is reachable and means "as sure as this engine
// gets": the strongest argument, a month of unbroken history behind it, and
// real space to reclaim. A threshold is only meaningful if the top of the range
// exists — an autoApplyScore above the reachable maximum would silently approve
// nothing.

export interface DropSignals {
  // null for redundancy-driven drops (usage isn't the argument there).
  readonly usageClass: UsageClass | null;
  // Collects behind the finding, not rows in the table. The storage layer
  // run-lengths an unchanged counter into a single row, so the row count of an
  // index idle for a year is one — and this term is the evidence-depth credit,
  // which is exactly backwards from what that index has.
  readonly snapshots: number;
  readonly redundant: boolean;
  readonly sizeBytes: number;
  // Times this exact index regressed before (from cooldown history).
  readonly pastRegressions: number;
}

export interface CreateSignals {
  readonly collscan: boolean;
  // The query reaches its documents through an index but sorts them in memory.
  // Only read when `collscan` is false — a scan is the stronger argument and
  // subsumes it.
  readonly sortedInMemory?: boolean;
  readonly count: number;
  readonly docCount: number;
  readonly pastRegressions: number;
  // How much the scan is actually costing (analysis/severity.ts). Defaults to
  // ROUTINE so callers without a workload source behave as before.
  readonly severity?: ScanSeverity;
}

const GB = 1024 ** 3;
// Snapshots for full history credit — a month at the 6h collect cadence. The
// old curve maxed out after ten, which is two and a half days.
const SNAPSHOTS_FOR_FULL_CREDIT = 125;
// Sightings of a query shape for full frequency credit.
const SIGHTINGS_FOR_FULL_CREDIT = 35;
// One regression is close to disqualifying, two are disqualifying.
const REGRESSION_PENALTY = 40;

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Drop confidence. The argument (55/50/35) carries most of it; evidence depth
// and reclaimable space decide the rest.
//
//   redundant       55  structural — provable from the index list alone
//   FLAT_ZERO       50  never touched across a history we can trust
//   PERIODIC_DEAD   35  it used to run and stopped; the job may come back
//   history       0-25  a month of unbroken collection for full credit
//   size          0-20  ~1 GB reclaimed for full credit
//
// Redundant and FLAT_ZERO never co-occur: a redundant index is excluded from the
// usage pass, so the ceiling is 55 + 25 + 20.
export function dropScore(signals: DropSignals): number {
  let score = 0;
  if (signals.redundant) score += 55;
  else if (signals.usageClass === "FLAT_ZERO") score += 50;
  else if (signals.usageClass === "PERIODIC_DEAD") score += 35;
  score += Math.min(25, Math.floor((25 * signals.snapshots) / SNAPSHOTS_FOR_FULL_CREDIT));
  if (signals.sizeBytes > 0) {
    score += Math.min(20, Math.round(20 * Math.log10(1 + (9 * signals.sizeBytes) / GB)));
  }
  score -= signals.pastRegressions * REGRESSION_PENALTY;
  return clamp(score);
}

// Create confidence. A repeated collection scan on a big collection is the
// argument; a shape seen three times on a small collection is a suggestion.
//
//   collscan        40  the query is scanning today
//   sorted in mem   25  it finds its documents by index, then sorts them by hand
//   frequency     0-30  35 sightings for full credit
//   collection    0-20  ≥1M docs 20, ≥10k 14, ≥1k 6
//   severity      0-10  CRITICAL 10, ELEVATED 5 — the measured cost of the scan
//
// An in-memory sort scores below a scan because the query is already finding
// its documents efficiently — the index would remove a sort, not a table walk.
// It is not scored as harmless, though: a blocking sort holds the whole result
// set in memory and fails outright at 100 MB, so it degrades by falling over
// rather than by slowing down.
//
// Severity is worth less than it might seem because it correlates with the
// other two: a scan doing ten million document reads is usually frequent, on a
// large collection, or both. It breaks the tie between two candidates the older
// signals score identically.
export function createScore(signals: CreateSignals): number {
  let score = 0;
  if (signals.collscan) score += 40;
  else if (signals.sortedInMemory === true) score += 25;
  score += Math.min(30, Math.floor((30 * signals.count) / SIGHTINGS_FOR_FULL_CREDIT));
  if (signals.docCount >= 1_000_000) score += 20;
  else if (signals.docCount >= 10_000) score += 14;
  else if (signals.docCount >= 1000) score += 6;
  if (signals.severity === "CRITICAL") score += 10;
  else if (signals.severity === "ELEVATED") score += 5;
  score -= signals.pastRegressions * REGRESSION_PENALTY;
  return clamp(score);
}

export interface NarrowSignals {
  // Executions behind the shapes that reach this index (workload.ts).
  readonly observedCount: number;
  // Keys being removed, and how many the index has now.
  readonly droppedKeys: number;
  readonly totalKeys: number;
  // Current size of the index, all replica members summed.
  readonly sizeBytes: number;
  readonly pastRegressions: number;
}

// Narrowing scores lower than anything else the engine proposes, and cannot
// reach RECOMMENDED_AUTO_APPLY_SCORE.
//
// Every other finding argues from something observed: this index was never
// used, that query scanned the collection. Narrowing argues from something NOT
// observed — no query mentioned the trailing key — and absence of evidence gets
// weaker the less traffic there was to observe. It is also the one finding that
// can make a query FAIL rather than slow down, by pushing a sort that the index
// used to serve into a blocking in-memory sort with a 100 MB ceiling.
//
// So the ceiling is deliberate: a human reads this one. What moves the score is
// how much watching sits behind it and how much it actually buys.
const NARROW_MAX_SCORE = 60;
// Executions for full credit on the evidence term. Higher than
// SIGHTINGS_FOR_FULL_CREDIT because that one asks "is this shape recurring",
// which a handful of sightings answers, while this asks "have we seen enough of
// this collection's traffic to trust a gap in it", which they do not.
const NARROW_SIGHTINGS_FOR_FULL_CREDIT = 500;

export function narrowScore(signals: NarrowSignals): number {
  let score = 15;
  score += Math.min(
    25,
    Math.floor((25 * signals.observedCount) / NARROW_SIGHTINGS_FOR_FULL_CREDIT),
  );
  // How much of the index is dead weight. Dropping two keys of three is a
  // different proposition from dropping one of five.
  score += Math.floor((10 * signals.droppedKeys) / Math.max(1, signals.totalKeys));
  // And what that weight costs. An index worth reclaiming is worth the rebuild.
  if (signals.sizeBytes >= GB) score += 10;
  else if (signals.sizeBytes >= 128 * 1024 * 1024) score += 6;
  score -= signals.pastRegressions * REGRESSION_PENALTY;
  return Math.min(NARROW_MAX_SCORE, clamp(score));
}

// What the dashboard suggests as an auto-approval threshold, and why. Set high
// enough that only the two arguments the engine can prove — redundancy, and
// idleness across a trustworthy history — clear it with evidence behind them.
export const RECOMMENDED_AUTO_APPLY_SCORE = 70;
