// Presentation helpers shared by the dashboard's sections.

export function badgeVariant(type: string): "secondary" | "destructive" | "default" | "outline" {
  if (type === "DROP_REDUNDANT" || type === "ADVISORY_REVIEW") return "secondary";
  if (type === "DROP_UNUSED") return "destructive";
  return "outline"; // CREATE / UPDATE / MERGE (additive)
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function fmtMicros(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}`;
}

export function DeltaCell({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground">—</span>;
  const tone = pct < 0 ? "text-green-600" : pct > 0 ? "text-red-600" : "text-muted-foreground";
  return (
    <span className={tone}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(0)}%
    </span>
  );
}
