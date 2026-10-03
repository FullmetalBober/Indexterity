import type { ClusterPasses, PassTiming } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { LocalTime } from "~/lib/local-time";

// How long each pass last took against this cluster, against what it was
// allowed, and where the time went (#571).
//
// The question this answers is the one a block cannot: a block says a pass
// stopped, and nothing said how close a pass that got through came to stopping.
// A collect that took four minutes of a five-minute budget is one bad hour from
// timing out, and it used to look exactly like one that took four seconds.

const RAN_AT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
};

// The pipeline's own order — read the cluster, decide, change it — so the panel
// reads top to bottom the way a pass of data moves. A pass this dashboard does
// not know by name sorts after them rather than disappearing.
const PASS_ORDER = ["collect", "classify", "suggest", "probe", "apply", "finalize"];

function passRank(task: string): number {
  const at = PASS_ORDER.indexOf(task);
  return at === -1 ? PASS_ORDER.length : at;
}

// Past this share of its budget a pass that landed is called out: the next
// slower hour is the one it does not fit in.
export const NEAR_BUDGET = 0.75;

/** A duration as a person says it: "380 ms", "4.2 s", "4 min 12 s", "1 h 5 min". */
export function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// How the pass ended, in words, for every outcome but the ordinary one — which
// gets no badge, because a column of "ok" is noise around the rows that are not.
// An outcome this dashboard has no wording for is shown by its name.
function outcomeBadge(timing: PassTiming) {
  switch (timing.outcome) {
    case "ok":
      if (timing.budgetMs !== null && timing.durationMs >= NEAR_BUDGET * timing.budgetMs) {
        return (
          <Badge variant="outline" className="border-amber-500 text-amber-700">
            close to its budget
          </Badge>
        );
      }
      return null;
    case "timed-out":
      return <Badge variant="destructive">ran out of time</Badge>;
    case "unreachable":
      return <Badge variant="destructive">could not reach the cluster</Badge>;
    case "tunnel-down":
      return <Badge variant="destructive">tunnel down</Badge>;
    case "credentials":
      return <Badge variant="destructive">credentials unreadable</Badge>;
    case "insecure":
      return <Badge variant="destructive">refused: no TLS</Badge>;
    case "unsupported":
      return <Badge variant="destructive">version not supported</Badge>;
    case "error":
      return <Badge variant="destructive">failed</Badge>;
    default:
      return <Badge variant="outline">{timing.outcome}</Badge>;
  }
}

// "took 4 min 12 s of its 5 min" — the ceiling beside the number, because a
// duration means nothing until you know what the pass was allowed.
function took(timing: PassTiming): string {
  const spent = fmtDuration(timing.durationMs);
  return timing.budgetMs === null
    ? `took ${spent}`
    : `took ${spent} of its ${fmtDuration(timing.budgetMs)}`;
}

// The three phases that cost the most, which is the part an operator acts on.
// A phase still open when the pass ended is the one a budget cut off, and its
// total is a floor, so it says so.
function whereTheTimeWent(timing: PassTiming): string | null {
  const top = timing.phases.slice(0, 3);
  if (top.length === 0) return null;
  return top
    .map((phase) => {
      const calls = phase.calls === 1 ? "" : ` over ${phase.calls} calls`;
      const open = phase.running ? ", still running" : "";
      return `${phase.name} ${fmtDuration(phase.totalMs)}${calls}${open}`;
    })
    .join("; ");
}

// How a paced pass runs from now on (#571, #588), said as the trade it is: the
// collect or suggest here needs longer than an hourly one is given, so it gets
// longer and runs less often, by the same factor.
function paceNote(timing: PassTiming): string | null {
  if (timing.pace === null) return null;
  return (
    `Paced: runs every ${timing.pace.everyHours} hours with ${fmtDuration(timing.pace.budgetMs)}, ` +
    `because a ${timing.task} here needs longer than an hourly one is given.`
  );
}

export function PassesPanel({
  passes,
  loading,
}: {
  passes: ClusterPasses | null;
  loading: boolean;
}) {
  if (passes === null || passes.passes.length === 0) {
    if (loading) return null;
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No pass timed yet</EmptyTitle>
          <EmptyDescription>
            Each pass records how long it took the next time it runs against this cluster. The
            collect runs hourly, and on connect.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const ordered = [...passes.passes].sort((a, b) => passRank(a.task) - passRank(b.task));
  return (
    <ul className="space-y-2">
      {ordered.map((timing) => {
        const breakdown = whereTheTimeWent(timing);
        const pace = paceNote(timing);
        return (
          <li key={timing.task} className="text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{timing.task}</code>
              <span>{took(timing)}</span>
              {outcomeBadge(timing)}
              {timing.pace === null ? null : (
                <Badge variant="outline">every {timing.pace.everyHours} h</Badge>
              )}
              <span className="text-muted-foreground">
                — started <LocalTime iso={timing.startedAt} options={RAN_AT} />
              </span>
            </div>
            {pace === null ? null : <p className="text-muted-foreground text-xs">{pace}</p>}
            {breakdown === null ? null : (
              <p className="text-muted-foreground text-xs">Where the time went: {breakdown}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
