// Presentation helpers shared by the dashboard's sections.
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMounted } from "~/lib/hydration";
import { LocalTime } from "~/lib/local-time";

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
// Returns the ISO instant rather than a formatted date, so the DRAWING can happen
// behind the hydration gate (LocalTime). It used to format here, in the reader's
// zone, from a function the server also calls — and `Date.now()` below is the
// second half of the same problem: the server compares against its clock and the
// browser against a later one, so a window expiring in that gap is a string on one
// side and null on the other. Both differences are now the client's alone.
export function dropsOn(rec: {
  state: string;
  hiddenAt: string | null;
  observeDays: number | null;
}): string | null {
  if (rec.state !== "HIDDEN" || rec.hiddenAt === null || rec.observeDays === null) return null;
  const due = new Date(new Date(rec.hiddenAt).getTime() + rec.observeDays * 86_400_000);
  if (Number.isNaN(due.getTime())) return null;
  return due.toISOString();
}

// Day and month: the observe window is weeks, not months, so the year would be
// noise on every row.
const DROPS_ON: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };

// The reason is the engine's own sentence (analysis/observe.ts, stored at hide
// time), and it is what makes two neighbouring rows with a 7-day and a 60-day
// window read as measured rather than as arbitrary (#269). Null whenever the
// policy baseline applied unchanged — there is nothing to explain then, and a
// tooltip saying "the default" would be worse than none.
//
// A tooltip rather than inline text because this lives in the Score cell, where
// a full sentence per row would bury the number the column is for.
function WithObserveReason({
  reason,
  children,
}: {
  reason: string | null;
  children: React.ReactNode;
}) {
  if (reason === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block cursor-help underline decoration-dotted underline-offset-2">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}

// When a hidden index's observe window ends, or nothing.
//
// Nothing covers two cases and both belong to the client, which is why this is a
// component and not a string. The DATE is drawn in the reader's zone, and whether
// the window has already passed is a comparison against the reader's clock — the
// server answers both differently, and a cell that disagrees with the server is a
// hydration error that throws away the page.
//
// Past the window the drop is waiting on the change window and the regression
// gate, so a DATE there would be a guess. That rule is kept; it now runs where the
// clock it depends on lives.
//
// What is no longer kept is drawing nothing (#268). Overshoot is the normal path
// rather than an edge — finalize runs hourly and its elective drop only fires
// inside the change window, so a narrow window routinely holds a due drop for
// days — and an empty cell is indistinguishable from a row that never had a
// window at all. So the state is named where the date used to be: still no
// promise about when, which is the part we cannot honestly make, but no longer
// silence about whether anything is pending.
export function DropsOn({
  rec,
}: {
  rec: {
    state: string;
    hiddenAt: string | null;
    observeDays: number | null;
    observeReason?: string | null;
  };
}) {
  const mounted = useMounted();
  const due = dropsOn(rec);
  if (due === null || !mounted) return null;
  const reason = rec.observeReason ?? null;
  if (new Date(due).getTime() <= Date.now()) {
    return (
      <WithObserveReason reason={reason}>
        <span className="block text-muted-foreground">due — waiting on the change window</span>
      </WithObserveReason>
    );
  }
  return (
    <WithObserveReason reason={reason}>
      <span className="block text-muted-foreground">
        drops <LocalTime iso={due} options={DROPS_ON} dateOnly />
      </span>
    </WithObserveReason>
  );
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
