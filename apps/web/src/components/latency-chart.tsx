import { defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts/tooltip";
import { scaleLinear, scaleUtc } from "d3-scale";
import { useEffect, useState } from "react";
import { Skeleton } from "~/components/ui/skeleton";

// The chart's own height, in px. Named because the placeholder below has to
// reserve exactly it — a box of a different size would move the page when the
// chart replaced it, which is the thing the placeholder exists to avoid.
const CHART_HEIGHT = 200;

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

// Takes either form because the axis hands over the Date the scale holds, while a
// tooltip reads it off a point (see tooltipTime).
//
// Empty for anything that is not a readable instant. It used to render one
// regardless, which is how a pixel offset came out as `1/1 03:00`: small numbers
// are milliseconds after the epoch, and `new Date(null)` is the epoch exactly.
// How an x value is written, on the axis ticks and in the tooltip heading. Two
// of them, because the two series this chart draws are sampled at different
// rates and a label that suits one lies about the other — see `dayLabel`.
export type TimeFormat = (at: unknown) => string;

// Null and unreadable values first, and not as a formality: `new Date(null)` is
// the epoch, so without this an absent value reads as a real instant in 1970
// rather than as nothing — which is the wrong answer a pixel offset was giving.
function instantOf(at: unknown): Date | null {
  if (at === null || at === undefined) return null;
  // Checked rather than claimed: a Date is used as-is, a string or number is
  // parsed, and anything else is not a timestamp — which is the answer the
  // caller already handles, since an unparseable value falls out below as null.
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? null : at;
  if (typeof at !== "string" && typeof at !== "number") return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Day and time, in the reader's own zone. For the latency series, whose points
// are one collect apart.
function timeLabel(at: unknown): string {
  const date = instantOf(at);
  if (date === null) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// The day alone, in UTC. For a series whose points ARE days.
//
// Two things wrong with using `timeLabel` on one, and the second is the one that
// matters. The visible half: every point in a daily series sits at midnight, so
// the label read `8/9 03:00` — an hour precise to the minute about a number that
// is a whole day's total, which invites reading the chart as hourly.
//
// The half that was actually wrong: the buckets are UTC midnights
// (`date_trunc('day', …)`) and the scale is `scaleUtc`, while `timeLabel` reads
// its parts with the LOCAL getters. East of UTC that shows as a harmless-looking
// hour; west of it the local date is the day BEFORE, so every tick and every
// tooltip on the footprint chart named the wrong day for readers in the
// Americas — off-by-one against an axis that was positioning them correctly.
// UTC getters here because the bucket is a UTC fact, not a local one.
export function dayLabel(at: unknown): string {
  const date = instantOf(at);
  if (date === null) return "";
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

// A tooltip point carries the datum AND where it was painted: `xValue`/`yValue`
// are the Date and the µs/op, `x`/`y` are scene coordinates in pixels — the
// library hit-tests with them (`focus.js`) and offsets them per facet
// (`facet.js`). Reading the wrong pair is silent, because both are numbers.
//
// It was being read wrong in both places. The heading formatted `point.x` as a
// timestamp, so every tooltip on a Kyiv-time screen said `1/1 03:00` — a point
// painted 40px in is 40ms after 1970-01-01T00:00Z. The value line printed
// `point.y`, so a latency of 58,000µs read as however many pixels down the line
// sat, which is a plausible-looking number and therefore worse.
//
// These take the POINT rather than a value so the choice cannot be made again at
// the call site.
interface TooltipPoint {
  readonly xValue?: unknown;
  readonly yValue?: unknown;
  // Declared and deliberately never read. They are on the real point, and naming
  // them here is what lets a test hand over one that carries both pairs — which
  // is the only way to assert that the datum is what gets read.
  readonly x?: unknown;
  readonly y?: unknown;
}

export function tooltipTime(
  point: TooltipPoint | undefined,
  format: TimeFormat = timeLabel,
): string {
  return point === undefined ? "" : format(point.xValue);
}

// How a y value is written, for the axis ticks and the tooltip both. Rounding to
// a whole number is right for µs/op and wrong for bytes, where every value on a
// small cluster would round to the same integer — so the caller that plots bytes
// passes fmtBytes and the unit label goes with it.
export type ValueFormat = (value: number) => string;

const roundToWhole: ValueFormat = (value) => String(Math.round(value));

// `—` rather than a number for the null points that draw the gaps: no ops went
// through, so there is no µs/op, and rounding null to `0 µs` would report an
// idle collection as an instant one. Same rule for a byte series, where the null
// is a day nobody collected and `0 B` would be a cluster that shed every index.
//
// `unit` is a SUFFIX and not always the axis label. The axis names the quantity
// once, at the side; the tooltip has to name it on every value, and a formatter
// that already writes one must not be given a second — `fmtBytes` returns
// "4.0 GB", so appending the axis label read "4.0 GB bytes". Callers whose
// format carries its own unit pass "".
export function tooltipValue(
  point: TooltipPoint | undefined,
  unit: string,
  format: ValueFormat = roundToWhole,
): string {
  const value = point?.yValue;
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return unit === "" ? format(value) : `${format(value)} ${unit}`;
}

// One line per series over a shared time axis. Nulls break the line (a gap, not
// a zero) — `y` accepts null natively, so nothing has to be filtered out first.
// Identity is carried by the legend's colored dots; text stays in text tokens,
// never series color.
export function LineChart({
  title,
  unit,
  series,
  pending = false,
  emptyNote,
  format = roundToWhole,
  timeFormat = timeLabel,
  tooltipUnit = unit,
  ariaLabel,
}: {
  title: string;
  // The axis label — the quantity, named once at the side.
  unit: string;
  series: readonly ChartSeries[];
  // How a value is written on the axis and in the tooltip. Defaults to whole
  // numbers, which is what µs/op wants; a byte series passes fmtBytes.
  format?: ValueFormat;
  // What the tooltip appends after each value. Defaults to the axis label,
  // which is right when the format is a bare number. A format that writes its
  // own unit passes "" — otherwise the tooltip reads "4.0 GB bytes".
  tooltipUnit?: string;
  // The chart's accessible name. Defaults to the per-collection phrasing the
  // latency charts want; a cluster-wide series says what it actually is rather
  // than inheriting a claim about collections it does not make.
  ariaLabel?: string;
  // How an instant is written, in the same two places. Defaults to day-and-time
  // in the reader's own zone, which is right for points one collect apart; a
  // series whose points are whole UTC days passes `dayLabel`.
  timeFormat?: TimeFormat;
  // The first fetch is still out. Distinct from an empty `series`, which means
  // the collector has answered and there is not enough to plot — "Not enough
  // samples yet" is a statement about the cluster, and it used to be made before
  // anybody had asked it anything (#72).
  pending?: boolean;
  // What kind of nothing this is, when the caller knows. "Not enough samples
  // yet" is true of a cluster nobody has collected twice, of one that took no
  // writes, and of one whose counters reset — and reading the same sentence for
  // all three is what had #85 filed against a working chart. The default stays
  // for callers with nothing better to say.
  emptyNote?: string | null;
}) {
  // The chart is drawn only in the browser, and this is not a preference.
  //
  // TanStack Charts pre-renders its SVG at a fixed `initialWidth` (640 by
  // default) and only learns the real width from a layout effect after mount.
  // The markup it emits carries `viewBox="0 0 640 …"` and `width="100%"`, so
  // until that effect runs the browser letterboxes a 640-wide drawing inside
  // whatever the column actually is — on a 1080p screen each of these columns is
  // about 900px, so the chart sat squeezed in the middle with dead space either
  // side, then snapped to full width when React hydrated.
  //
  // Every fixed guess is wrong at some viewport, so there is no number to tune.
  // A reserved empty box of exactly CHART_HEIGHT is honest instead: nothing
  // moves when the real chart arrives, and nobody is shown a chart drawn to the
  // wrong scale. Nothing is lost from the server render — this is behind auth,
  // and the SVG was never the readable part anyway.
  const [measured, setMeasured] = useState(false);
  useEffect(() => setMeasured(true), []);

  // Nothing has answered yet, so nothing is claimed about the cluster. The box
  // is the chart's own height, which is the same box the un-measured branch at
  // the bottom of this file reserves — so the arrival of real data moves
  // nothing.
  if (pending) {
    return (
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        <Skeleton className="mt-1 w-full" style={{ height: CHART_HEIGHT }} />
      </div>
    );
  }

  const samples = toSamples(series);
  const withValues = samples.filter((sample) => sample.value !== null);
  // Two points is the minimum that draws a line rather than a dot, and a series
  // of nothing but nulls has no line at all.
  if (samples.length < 2 || withValues.length === 0) {
    return (
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="mt-1 text-muted-foreground text-sm">
          {emptyNote ?? "Not enough samples yet."}
        </p>
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
      axis: { line: false, ticks: { format: timeFormat } },
    },
    y: {
      scale: scaleLinear,
      nice: true,
      grid: true,
      axis: { line: false, label: unit, ticks: { format } },
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
      format: (point) => tooltipValue(point, tooltipUnit, format),
      // Every point in a group shares the timestamp, so the first one names it.
      formatGroup: (points) => tooltipTime(points[0], timeFormat),
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
      {measured ? (
        <Chart
          className="mt-1 w-full text-xs"
          height={CHART_HEIGHT}
          definition={definition}
          ariaLabel={ariaLabel ?? `${title} per collection, in ${unit}`}
        />
      ) : (
        <div className="mt-1 w-full" style={{ height: CHART_HEIGHT }} aria-hidden="true" />
      )}
    </div>
  );
}
