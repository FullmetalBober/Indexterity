import type { CollectionLatencySeries, LatencySeriesPoint } from "@repo/contracts";

// Which collections each latency chart draws, and in what colour.
//
// Lives here rather than inline in the route because that is where the bug was: one
// shared ranking by total point count picked the four collections with the most
// samples for BOTH charts, regardless of whether any of them had ever been written
// to. On a read-heavy cluster all four came back with null writes and the write
// chart said "Not enough samples yet" — while other collections on the same cluster
// had over a thousand write ops. The panel was reporting the ranking's blind spot as
// an absence of data.
//
// Ranking per metric is the fix: a chart cannot rank by evidence it does not draw.
export interface ChartSeries {
  readonly label: string;
  readonly color: string;
  readonly points: readonly { readonly t: string; readonly v: number | null }[];
}

export interface LatencyCharts {
  readonly readSeries: ChartSeries[];
  readonly writeSeries: ChartSeries[];
  // Collections on neither chart, for the "+N more" note under them.
  readonly foldedCount: number;
}

function namespaceOf(series: CollectionLatencySeries): string {
  return `${series.database}.${series.collection}`;
}

// Ranked by how many points this chart can actually PLOT, not by how many readings
// the collection has. A collection with a hundred samples and no writes belongs
// nowhere on the write chart.
function rank(
  collections: readonly CollectionLatencySeries[],
  metric: (point: LatencySeriesPoint) => number | null,
  slots: number,
): CollectionLatencySeries[] {
  return [...collections]
    .map((series) => ({
      series,
      drawable: series.points.filter((point) => metric(point) !== null).length,
    }))
    .filter((entry) => entry.drawable > 0)
    .sort(
      (a, b) =>
        b.drawable - a.drawable || namespaceOf(a.series).localeCompare(namespaceOf(b.series)),
    )
    .slice(0, slots)
    .map((entry) => entry.series);
}

export function latencyCharts(
  collections: readonly CollectionLatencySeries[],
  palette: readonly string[],
  fallbackColor = "#2a78d6",
): LatencyCharts {
  const slots = Math.max(1, palette.length);
  const readCollections = rank(collections, (point) => point.readMicros, slots);
  const writeCollections = rank(collections, (point) => point.writeMicros, slots);

  // Colour by NAMESPACE, over the union of what the two charts chose, so a collection
  // keeps its colour across both even though the two lists now differ. Which they
  // should: a collection with reads and no writes belongs on one chart and not the
  // other, and that is the honest answer rather than an empty panel.
  const union = [...new Set([...readCollections, ...writeCollections].map(namespaceOf))];
  const colors = new Map(
    union.map((namespace, i) => [namespace, palette[i % slots] ?? fallbackColor]),
  );

  const build = (
    chosen: readonly CollectionLatencySeries[],
    metric: (point: LatencySeriesPoint) => number | null,
  ): ChartSeries[] =>
    chosen.map((series) => ({
      label: namespaceOf(series),
      color: colors.get(namespaceOf(series)) ?? fallbackColor,
      points: series.points.map((point) => ({ t: point.capturedAt, v: metric(point) })),
    }));

  return {
    readSeries: build(readCollections, (point) => point.readMicros),
    writeSeries: build(writeCollections, (point) => point.writeMicros),
    // Against the union, so the note counts collections that reached NEITHER chart
    // rather than letting one metric's ranking speak for both.
    foldedCount: Math.max(0, collections.length - union.length),
  };
}
