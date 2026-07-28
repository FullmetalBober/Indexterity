import { CartesianGrid, Line, LineChart as RechartsLine, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent } from "./ui/chart";

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

function timeLabel(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Recharts wants one row per timestamp; series labels contain dots (db.coll),
// which recharts dataKeys would treat as nested paths — so keys are slugged.
function slug(label: string): string {
  return label.replace(/[^a-zA-Z0-9]+/g, "-");
}

type Row = Record<string, number | null>;

function toRows(series: readonly ChartSeries[]): Row[] {
  const byTime = new Map<number, Row>();
  for (const s of series) {
    const key = slug(s.label);
    for (const point of s.points) {
      const ms = Date.parse(point.t);
      const row = byTime.get(ms) ?? { t: ms };
      row[key] = point.v;
      byTime.set(ms, row);
    }
  }
  return [...byTime.values()].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

// One shadcn/recharts line per series over a shared time axis. Nulls break the
// line (a gap, not a zero). Identity is carried by the legend's colored dots;
// text stays in text tokens, never series color.
export function LineChart({
  title,
  unit,
  series,
}: {
  title: string;
  unit: string;
  series: readonly ChartSeries[];
}) {
  const rows = toRows(series);
  const hasValues = series.some((s) => s.points.some((p) => p.v !== null));
  if (rows.length < 2 || !hasValues) {
    return (
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="mt-1 text-muted-foreground text-sm">Not enough samples yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium text-sm">{title}</h3>
        <div className="flex gap-3">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1 text-muted-foreground text-xs">
              <svg width="8" height="8" role="presentation">
                <circle cx="4" cy="4" r="4" fill={s.color} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <ChartContainer className="mt-1" height={200}>
        <RechartsLine data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={timeLabel}
            tickLine={false}
            axisLine={false}
            fontSize={10}
            tickMargin={6}
          />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            fontSize={10}
            tickFormatter={(value: number) => String(Math.round(value))}
            label={{ value: unit, angle: -90, position: "insideLeft", fontSize: 10 }}
          />
          <Tooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) =>
                  typeof label === "number" ? timeLabel(label) : String(label)
                }
                valueFormatter={(value) => `${Math.round(value)} ${unit}`}
              />
            }
          />
          {series.map((s) => (
            <Line
              key={s.label}
              dataKey={slug(s.label)}
              name={s.label}
              type="linear"
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "white" }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </RechartsLine>
      </ChartContainer>
    </div>
  );
}
