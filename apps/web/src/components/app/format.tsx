// Presentation helpers shared by the dashboard's sections.

export function badgeVariant(type: string): "secondary" | "destructive" | "default" | "outline" {
  if (type === "DROP_REDUNDANT" || type === "ADVISORY_REVIEW") return "secondary";
  if (type === "DROP_UNUSED") return "destructive";
  return "outline"; // CREATE / UPDATE / MERGE (additive)
}

// "2 / 3" while there is a cap, the bare count when there is not. Shared,
// because the same meter is drawn in two places: the plan summary on the org
// page, and the warning beside the form that spends it.
export function usage(used: number, limit: number | null): string {
  return limit === null ? String(used) : `${used} / ${limit}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function fmtMicros(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}`;
}

// When a hidden index is due to be dropped, or null if that is not a question
// yet. The observe window is chosen per index from its own usage pattern, so it
// is not something a reader can derive from the policy setting — a monthly
// report waits out a full cycle, an index still serving traffic answers within
// days. Null once the window has passed: the drop is then waiting on the change
// window and the regression gate, and naming a date would be a guess.
export function dropsOn(rec: {
  state: string;
  hiddenAt: string | null;
  observeDays: number | null;
}): string | null {
  if (rec.state !== "HIDDEN" || rec.hiddenAt === null || rec.observeDays === null) return null;
  const due = new Date(new Date(rec.hiddenAt).getTime() + rec.observeDays * 86_400_000);
  if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) return null;
  return due.toLocaleDateString(undefined, { day: "numeric", month: "short" });
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
