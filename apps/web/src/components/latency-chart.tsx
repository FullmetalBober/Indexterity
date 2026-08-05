import { defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts/tooltip";
import { scaleLinear, scaleUtc } from "d3-scale";

// MongoDB-family categorical slots, green first — validated with the dataviz
// scripts/validate_palette.js (light mode): lightness band, chroma, CVD +
// normal-vision floors and 3:1 contrast all PASS. Blue↔green tritan ΔE 7.2 sits
// in the 6–8 band, which is legal with secondary encoding — these charts carry
// a legend, direct labels and the summary table.
export const SERIES_PALETTE = ["#00A35C", "#016BF8", "#C77F00", "#B45AF2"];

export interface ChartPoint {
  readonly t: string; // ISO-8601
  readonly v: number | null;
}

export interface ChartSeries {
  readonly label: string;
  readonly color: string;
  readonly points: readonly ChartPoint[];
}

// One row per series per timestamp — the shape a grammar-of-graphics library
// wants. Recharts needed the opposite: one row per timestamp with a column per
// series, which meant pivoting, and slugging the labels because a `db.coll` key
// read as a nested path. Both of those are gone.
interface Sample {
  readonly label: string;
  readonly at: Date;
  readonly value: number | null;
}

function toSamples(series: readonly ChartSeries[]): Sample[] {
  return series.flatMap((one) =>
    one.points.map((point) => ({
      label: one.label,
      at: new Date(point.t),
      value: point.v,
    })),
  );
}

// Takes either form because the axis hands over the Date the scale holds while a
// tooltip point's x is widened to the library's ChartValue union.
function timeLabel(at: Date | number): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// One line per series over a shared time axis. Nulls break the line (a gap, not
// a zero) — `y` accepts null natively, so nothing has to be filtered out first.
// Identity is carried by the legend's colored dots; text stays in text tokens,
// never series color.
export function LineChart({
  title,
  unit,
  series,
}: {
  title: string;
  unit: string;
  series: readonly ChartSeries[];
}) {
  const samples = toSamples(series);
  const withValues = samples.filter((sample) => sample.value !== null);
  // Two points is the minimum that draws a line rather than a dot, and a series
  // of nothing but nulls has no line at all.
  if (samples.length < 2 || withValues.length === 0) {
    return (
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="mt-1 text-muted-foreground text-sm">Not enough samples yet.</p>
      </div>
    );
  }

  const definition = defineChart({
    marks: [
      lineY(samples, {
        x: (sample: Sample) => sample.at,
        y: (sample: Sample) => sample.value,
        // z splits the rows into one line per series; color paints them from the
        // palette below. Both key off the label, which is the namespace.
        z: (sample: Sample) => sample.label,
        color: (sample: Sample) => sample.label,
        strokeWidth: 2,
      }),
    ],
    x: {
      scale: scaleUtc,
      grid: false,
      axis: { line: false, ticks: { format: timeLabel } },
    },
    y: {
      scale: scaleLinear,
      nice: true,
      grid: true,
      axis: {
        line: false,
        label: unit,
        ticks: { format: (value: number) => String(Math.round(value)) },
      },
    },
    // Explicit domain and range rather than an inferred order: the palette's
    // slots were validated in that order, and a series appearing or disappearing
    // between collects must not repaint the ones beside it.
    color: {
      domain: series.map((one) => one.label),
      range: series.map((one) => one.color),
    },
    tooltip: {
      use: tooltip,
      format: (point) => `${Math.round(point.y)} ${unit}`,
      // Every point in a group shares the timestamp, so the first one names it.
      formatGroup: (points) => {
        const first = points[0];
        return first === undefined ? "" : timeLabel(first.x);
      },
    },
    // The data moves once every six hours. An animation here is decoration on a
    // number nobody is watching change.
    animate: false,
  });

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium text-sm">{title}</h3>
        <div className="flex gap-3">
          {series.map((one) => (
            <span key={one.label} className="flex items-center gap-1 text-muted-foreground text-xs">
              <svg width="8" height="8" role="presentation">
                <circle cx="4" cy="4" r="4" fill={one.color} />
              </svg>
              {one.label}
            </span>
          ))}
        </div>
      </div>
      <Chart
        className="mt-1 w-full text-xs"
        height={200}
        definition={definition}
        ariaLabel={`${title} per collection, in ${unit}`}
      />
    </div>
  );
}
