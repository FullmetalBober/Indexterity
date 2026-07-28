import type { ReactElement } from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "../../lib/utils";

// shadcn-style chart primitives, adapted for strict types (no any/as): a
// responsive container + the styled tooltip content recharts clones its
// injected props into. Series colors flow as explicit props.

export function ChartContainer({
  className,
  height = 200,
  children,
}: {
  className?: string;
  height?: number;
  children: ReactElement;
}) {
  // recharts 3 draws client-side only — SSR ships the section + data and the
  // chart hydrates in; the container reserves the height to avoid layout shift.
  return (
    <div className={cn("w-full text-xs", className)} style={{ minHeight: height }}>
      <ResponsiveContainer width="100%" height={height}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

// The subset of the entry shape recharts injects that the tooltip reads.
export interface ChartTooltipEntry {
  readonly name?: string | number;
  readonly value?: number | string | null;
  readonly color?: string;
}

// Passed as an element to <Tooltip content={...}> — recharts injects
// active/payload/label at render time.
export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
}: {
  active?: boolean;
  payload?: readonly ChartTooltipEntry[];
  label?: string | number;
  labelFormatter?: (label: string | number) => string;
  valueFormatter?: (value: number) => string;
}) {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  return (
    <div className="rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-md">
      {label !== undefined ? (
        <div className="text-muted-foreground">
          {labelFormatter === undefined ? String(label) : labelFormatter(label)}
        </div>
      ) : null}
      {payload.map((entry) => (
        <div key={String(entry.name)} className="flex items-center gap-1.5">
          <svg width="8" height="8" role="presentation">
            <circle cx="4" cy="4" r="4" fill={entry.color ?? "currentColor"} />
          </svg>
          <span>{String(entry.name ?? "")}</span>
          <span className="text-muted-foreground">
            {typeof entry.value === "number"
              ? valueFormatter === undefined
                ? String(entry.value)
                : valueFormatter(entry.value)
              : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}
