import type { PassHistorySeries } from "@repo/contracts";

// A week of the hourly passes' durations, as the Passes chart draws them (#639).

// How far back the chart reaches. The rows go back twice as far
// (jobs/timings.ts PASS_HISTORY_DAYS), so the week is whole between sweeps.
export const PASS_HISTORY_CHART_DAYS = 7;

// The longest stretch with no run that is still one line. The slowest pace runs
// a pass every four hours (jobs/pacing.ts MAX_TIER); an hour of slack on top, and
// anything longer is an outage the line must not draw across.
const MAX_GAP_MS = 5 * 3_600_000;

const HOUR_MS = 3_600_000;

/** One pass's longest run in one hour, as postgres folds them. */
export interface PassHour {
  readonly task: string;
  readonly hour: Date;
  readonly maxMs: number;
}

/**
 * One series per pass, oldest hour first, with a null point opening every gap
 * longer than the slowest pace — so the chart breaks the line there instead of
 * drawing a level nothing measured.
 */
export function passHistorySeries(rows: readonly PassHour[]): PassHistorySeries[] {
  const byTask = new Map<string, PassHour[]>();
  for (const row of rows) {
    const list = byTask.get(row.task) ?? [];
    list.push(row);
    byTask.set(row.task, list);
  }
  return [...byTask].map(([task, hours]) => {
    const sorted = [...hours].sort((a, b) => a.hour.getTime() - b.hour.getTime());
    const points: PassHistorySeries["points"][number][] = [];
    let previous: number | null = null;
    for (const { hour, maxMs } of sorted) {
      const at = hour.getTime();
      if (previous !== null && at - previous > MAX_GAP_MS) {
        points.push({ hour: new Date(previous + HOUR_MS).toISOString(), maxMs: null });
      }
      points.push({ hour: hour.toISOString(), maxMs: Math.max(0, Math.round(maxMs)) });
      previous = at;
    }
    return { task, points };
  });
}
