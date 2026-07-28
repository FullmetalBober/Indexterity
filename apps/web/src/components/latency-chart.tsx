import { useState } from "react";

// Categorical slots 1-4 (dataviz default palette, light mode) — validated with
// scripts/validate_palette.js: CVD/normal-vision floors pass; aqua+yellow sit
// below 3:1 contrast, so direct labels + the summary table provide relief.
export const SERIES_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];

export interface ChartPoint {
  readonly t: string; // ISO-8601
  readonly v: number | null;
}

export interface ChartSeries {
  readonly label: string;
  readonly color: string;
  readonly points: readonly ChartPoint[];
}

const W = 640;
const H = 200;
const PAD = { left: 48, right: 8, top: 8, bottom: 22 };

function timeLabel(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// One line per series over a shared time axis. Nulls break the line (a gap, not
// a zero). Hover shows a crosshair + tooltip; identity is carried by the legend
// and per-series colored dots (text stays in text tokens, never series color).
export function LineChart({
  title,
  unit,
  series,
}: {
  title: string;
  unit: string;
  series: readonly ChartSeries[];
}) {
  const [hover, setHover] = useState<number | null>(null);

  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort();
  const values = series.flatMap((s) => s.points.map((p) => p.v)).filter((v) => v !== null);
  if (times.length < 2 || values.length === 0) {
    return (
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="mt-1 text-muted-foreground text-sm">Not enough samples yet.</p>
      </div>
    );
  }

  const t0 = Date.parse(times[0] ?? "");
  const t1 = Date.parse(times[times.length - 1] ?? "");
  const span = Math.max(1, t1 - t0);
  const vMax = Math.max(...values) * 1.1;
  const x = (iso: string) =>
    PAD.left + ((Date.parse(iso) - t0) / span) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / vMax) * (H - PAD.top - PAD.bottom);

  // Split each series into null-free segments so gaps stay gaps.
  const paths = series.map((s) => {
    const segments: string[] = [];
    let d = "";
    for (const p of s.points) {
      if (p.v === null) {
        if (d !== "") segments.push(d);
        d = "";
        continue;
      }
      d += `${d === "" ? "M" : " L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    }
    if (d !== "") segments.push(d);
    return segments;
  });

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => ({
    yPos: PAD.top + (1 - f) * (H - PAD.top - PAD.bottom),
    label: Math.round(vMax * f),
  }));

  const hoverTime = hover === null ? null : (times[hover] ?? null);

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    times.forEach((t, i) => {
      const dist = Math.abs(x(t) - px);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHover(best);
  }

  return (
    <div className="relative">
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
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 w-full"
        role="img"
        aria-label={`${title} over time`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {gridLines.map((line) => (
          <g key={line.yPos}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={line.yPos}
              y2={line.yPos}
              stroke="currentColor"
              strokeOpacity="0.08"
            />
            <text
              x={PAD.left - 6}
              y={line.yPos + 3}
              textAnchor="end"
              fontSize="9"
              fill="currentColor"
              fillOpacity="0.45"
            >
              {line.label}
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="currentColor"
          strokeOpacity="0.2"
        />
        <text x={PAD.left} y={H - 6} fontSize="9" fill="currentColor" fillOpacity="0.45">
          {timeLabel(times[0] ?? "")}
        </text>
        <text
          x={W - PAD.right}
          y={H - 6}
          textAnchor="end"
          fontSize="9"
          fill="currentColor"
          fillOpacity="0.45"
        >
          {timeLabel(times[times.length - 1] ?? "")} · {unit}
        </text>

        {paths.map((segments, i) => {
          const s = series[i];
          if (s === undefined) return null;
          return segments.map((d) => (
            <path
              key={`${s.label}${d.slice(0, 24)}`}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ));
        })}

        {hoverTime !== null ? (
          <g>
            <line
              x1={x(hoverTime)}
              x2={x(hoverTime)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="currentColor"
              strokeOpacity="0.25"
            />
            {series.map((s) => {
              const point = s.points.find((p) => p.t === hoverTime);
              if (point === undefined || point.v === null) return null;
              return (
                <circle
                  key={s.label}
                  cx={x(hoverTime)}
                  cy={y(point.v)}
                  r="4"
                  fill={s.color}
                  stroke="white"
                  strokeWidth="2"
                />
              );
            })}
          </g>
        ) : null}
      </svg>

      {hoverTime !== null ? (
        <div
          className="pointer-events-none absolute top-8 rounded-md border bg-background px-2 py-1 shadow-sm"
          style={{
            left: `${Math.min(82, (x(hoverTime) / W) * 100)}%`,
          }}
        >
          <div className="text-muted-foreground text-xs">{timeLabel(hoverTime)}</div>
          {series.map((s) => {
            const point = s.points.find((p) => p.t === hoverTime);
            return (
              <div key={s.label} className="flex items-center gap-1 text-xs">
                <svg width="8" height="8" role="presentation">
                  <circle cx="4" cy="4" r="4" fill={s.color} />
                </svg>
                <span>{s.label}</span>
                <span className="text-muted-foreground">
                  {point?.v == null ? "—" : `${Math.round(point.v)} ${unit}`}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
