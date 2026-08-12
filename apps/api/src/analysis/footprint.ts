import type { IndexSizePoint } from "@repo/contracts";

// The cluster's total index footprint over time (#160), summarized.
//
// The bucketing itself is one SQL statement (insights.controller.ts) — this is
// the part that has to read the result correctly, and the part worth testing,
// because every mistake available here is a confident wrong number rather than a
// crash.

export interface FootprintSummary {
  readonly firstBytes: number | null;
  readonly latestBytes: number | null;
  readonly changeBytes: number | null;
}

// The two ends of the DRAWABLE series, and the distance between them.
//
// Not `points[0]` and `points.at(-1)`: the series has holes, and a hole is a day
// nobody collected. Reading a null end as zero would report a cluster whose
// collection stopped last Tuesday as having shed its entire index footprint,
// which is the most alarming number this product could produce and would be
// entirely our own doing.
//
// `changeBytes` stays null until two DIFFERENT days have been collected. One
// point is a measurement, not a trend, and 0 would say "no change" about a
// cluster that has been looked at once.
export function summarizeFootprint(points: readonly IndexSizePoint[]): FootprintSummary {
  const drawn = points.filter((point) => point.totalBytes !== null);
  const first = drawn[0]?.totalBytes ?? null;
  const latest = drawn[drawn.length - 1]?.totalBytes ?? null;
  if (drawn.length < 2 || first === null || latest === null) {
    return { firstBytes: first, latestBytes: latest, changeBytes: null };
  }
  return { firstBytes: first, latestBytes: latest, changeBytes: latest - first };
}
