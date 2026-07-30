import type { UsageClass } from "@repo/contracts";

// Confidence scoring (0–100). The score gates pipeline ENTRY — what gets
// proposed and what auto-approves — never the safety stages: an auto-approved
// drop still goes hide → observe → regression/pre-flight gates before deletion.

export interface DropSignals {
  // null for redundancy-driven drops (usage isn't the argument there).
  readonly usageClass: UsageClass | null;
  readonly snapshots: number;
  readonly redundant: boolean;
  readonly sizeBytes: number;
  // Times this exact index regressed before (from cooldown history).
  readonly pastRegressions: number;
}

export interface CreateSignals {
  readonly collscan: boolean;
  readonly count: number;
  readonly docCount: number;
  readonly pastRegressions: number;
}

const GB = 1024 ** 3;

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Drop confidence: dead usage and redundancy are the strong arguments, history
// depth and reclaimable size strengthen them, past regressions cut hard.
export function dropScore(signals: DropSignals): number {
  let score = 0;
  if (signals.usageClass === "FLAT_ZERO") score += 40;
  if (signals.usageClass === "PERIODIC_DEAD") score += 30;
  if (signals.redundant) score += 45;
  score += Math.min(20, signals.snapshots * 2);
  // 0 → +0, ~100 MB → +8, ≥1 GB → +15 (log-ish, capped).
  if (signals.sizeBytes > 0) {
    score += Math.min(15, Math.round((15 * Math.log10(1 + (9 * signals.sizeBytes) / GB)) / 1));
  }
  score -= signals.pastRegressions * 40;
  return clamp(score);
}

// Create confidence: a repeated collection scan on a big collection is the
// argument; past regressions (built then rolled back) cut hard.
export function createScore(signals: CreateSignals): number {
  let score = 0;
  if (signals.collscan) score += 35;
  score += Math.min(25, signals.count);
  if (signals.docCount >= 10_000) score += 25;
  else if (signals.docCount >= 1000) score += 10;
  score -= signals.pastRegressions * 40;
  return clamp(score);
}
