import type { CollectionLatencySeries, LatencyGap, LatencySeriesPoint } from "@repo/contracts";

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
  // How many DISTINCT collections the two charts draw between them, for the
  // "+N more" note under them. Not `readSeries.length`, and not the larger of
  // the two: the charts rank separately and now routinely draw disjoint sets, so
  // either of those counts one chart's work as the whole panel's and overstates
  // what is folded away.
  readonly chartedCount: number;
  // What to say when the chart above has no series at all. Null when it has
  // some, or when the collector has told us nothing to explain.
  readonly readNote: string | null;
  readonly writeNote: string | null;
}

// Least self-resolving first. A restart is a fact about the cluster and outranks
// a quiet counter; waiting on a second collect outranks nothing, because it is
// the one that fixes itself and the only gap a brand-new cluster can report.
const GAP_RANK: readonly LatencyGap[] = [
  "COUNTERS_RESET",
  "NO_OPS_RECORDED",
  "AWAITING_SECOND_COLLECT",
];

function noteFor(gap: LatencyGap, metric: "read" | "write"): string {
  switch (gap) {
    case "AWAITING_SECOND_COLLECT":
      return "Waiting on a second collect — a rate needs two readings to compare.";
    case "NO_OPS_RECORDED":
      return `No ${metric} operations recorded over this history.`;
    case "COUNTERS_RESET":
      return "The server restarted and its counters reset, so this window cannot be measured.";
  }
}

// One sentence for the whole chart, from the gaps its collections reported.
// Null when nobody reported one — an older API that does not send them, or a
// cluster with no collections at all, both of which the chart's own "not enough
// samples" already covers honestly.
function chartNote(
  collections: readonly CollectionLatencySeries[],
  gapOf: (series: CollectionLatencySeries) => LatencyGap | null,
  metric: "read" | "write",
): string | null {
  const seen = new Set(collections.map(gapOf).filter((gap) => gap !== null));
  const gap = GAP_RANK.find((candidate) => seen.has(candidate));
  return gap === undefined ? null : noteFor(gap, metric);
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
    // The union, so the caller's "+N more" subtracts what BOTH charts drew
    // rather than letting one metric's ranking speak for the panel.
    chartedCount: union.length,
    // Only for a chart that drew nothing. A chart with a line on it has already
    // said everything it needs to.
    readNote:
      readCollections.length > 0 ? null : chartNote(collections, (one) => one.readGap, "read"),
    writeNote:
      writeCollections.length > 0 ? null : chartNote(collections, (one) => one.writeGap, "write"),
  };
}
