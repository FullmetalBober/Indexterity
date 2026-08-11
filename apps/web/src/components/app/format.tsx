// Presentation helpers shared by the dashboard's sections.

export function badgeVariant(type: string): "secondary" | "destructive" | "default" | "outline" {
  if (type === "DROP_REDUNDANT" || type === "ADVISORY_REVIEW") return "secondary";
  if (type === "DROP_UNUSED") return "destructive";
  // REORDER is additive too — it builds before it retires — but it is the only
  // one that touches a constraint-bearing index, so it does not sit in the same
  // quiet outline as an ordinary create.
  if (type === "REORDER") return "default";
  return "outline"; // CREATE / UPDATE / MERGE (additive)
}

// "2 / 3" while there is a cap, the bare count when there is not. Shared,
// because the same meter is drawn in two places: the plan summary on the org
// page, and the warning beside the form that spends it.
export function usage(used: number, limit: number | null): string {
  return limit === null ? String(used) : `${used} / ${limit}`;
}

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

// A gigabyte tier, because index footprints reach one (#160). Without it the
// footprint chart's axis reads `6144.0 MB` and the ROI headline on a cluster
// that has had a few large drops reads the same way — a number nobody converts
// in their head, on the one panel whose whole job is to be read at a glance.
//
// Sign-preserving: the footprint delta is negative when the cluster is carrying
// less index than it was, which is the answer everybody wants and the one this
// helper must not lose to an abs().
export function fmtBytes(bytes: number): string {
  const size = Math.abs(bytes);
  if (size >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (size >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / KB).toFixed(0)} KB`;
}

// The same, with the sign always written. `+6.0 GB` is a cluster that grew, and
// growth is the finding — a bare `6.0 GB` beside the word "change" reads as a
// footprint, not as a delta.
export function fmtBytesDelta(bytes: number): string {
  return bytes > 0 ? `+${fmtBytes(bytes)}` : fmtBytes(bytes);
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
