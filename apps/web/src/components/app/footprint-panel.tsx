import type { ClusterIndexSizeSeries } from "@repo/contracts";
import { fmtBytes, fmtBytesDelta } from "~/components/app/format";
import { type ChartSeries, LineChart, SERIES_PALETTE } from "~/components/latency-chart";

// Total index bytes over the trend window (#160).
//
// The ROI panel next to this one answers "how much did we save" and cannot
// answer "is it going down": both its numbers are cumulative and only ever
// climb, because they count what the engine removed. A cluster where we freed
// 4 GB while the application added 6 GB has a triumphant ROI panel and a bigger
// bill, and this is the only place on the dashboard that says so.

// One line, not several: the cluster total is the number that answers the
// question, and a per-collection breakdown is the follow-up (the Collections
// table below already carries the current footprint per namespace).
const FOOTPRINT_COLOR = SERIES_PALETTE[0] ?? "#00A35C";

// Every day in the window, nulls included. The nulls are the point — the chart
// breaks its line at them, so a week nobody collected renders as a gap instead
// of a straight line implying the footprint held steady through it.
function toSeries(series: ClusterIndexSizeSeries): ChartSeries[] {
  if (series.points.length === 0) return [];
  return [
    {
      label: "Total index bytes",
      color: FOOTPRINT_COLOR,
      points: series.points.map((point) => ({ t: point.day, v: point.totalBytes })),
    },
  ];
}

// What the headline says when there is no delta to state. Two different days
// have to have been collected before "change" means anything, and the three
// reasons there might not be are worth telling apart — a brand-new cluster
// resolves itself tomorrow, and a cluster nobody has collected at all does not.
function summary(series: ClusterIndexSizeSeries): { headline: string; note: string } {
  const collected = series.points.filter((point) => point.totalBytes !== null).length;
  if (series.latestBytes === null) {
    return {
      headline: "Nothing collected yet",
      note: "The first collect records how much index this cluster carries. It runs hourly, and on connect.",
    };
  }
  if (series.changeBytes === null || collected < 2) {
    return {
      headline: fmtBytes(series.latestBytes),
      note: "One day collected so far — a trend needs two, so there is nothing to compare against yet.",
    };
  }
  if (series.changeBytes === 0) {
    return {
      headline: fmtBytes(series.latestBytes),
      note: "Unchanged over the window: the engine's savings and what the application added cancel out.",
    };
  }
  const direction = series.changeBytes < 0 ? "smaller" : "larger";
  return {
    headline: fmtBytes(series.latestBytes),
    note: `${fmtBytesDelta(series.changeBytes)} over the window — ${direction} than it was, net of everything the application added.`,
  };
}

export function FootprintPanel({
  series,
  loading,
}: {
  series: ClusterIndexSizeSeries;
  loading: boolean;
}) {
  const { headline, note } = summary(series);
  return (
    <div>
      {/* Drawn even while pending — LineChart reserves its own height and says
          nothing about the cluster until it has been told something. The
          sentence below is the part that has to wait. */}
      <LineChart
        title="Total index bytes"
        unit="bytes"
        series={toSeries(series)}
        pending={loading}
        format={fmtBytes}
        emptyNote="Not enough history yet — this needs two days of collects to draw a line."
      />
      {loading ? null : (
        <p className="mt-2 text-sm">
          <span
            className={
              series.changeBytes !== null && series.changeBytes > 0
                ? "font-medium text-red-600"
                : "font-medium"
            }
          >
            {headline}
          </span>{" "}
          <span className="text-muted-foreground">{note}</span>
        </p>
      )}
    </div>
  );
}
