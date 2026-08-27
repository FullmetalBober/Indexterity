import type { ClusterNodes } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { LocalTime } from "~/lib/local-time";

// With the year, same reasoning as the sessions list: a roster stale enough to
// matter is exactly the one where the day alone is ambiguous.
const COLLECTED_AT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

// The node roster (#100): every member the last collect saw, its role, and
// whether it answered — the panel that makes partial coverage a sentence on
// screen ("4 of 5 members answered") instead of a code-reading exercise. The
// facts were always collected; they were summed away before reaching here.

function roleBadge(role: ClusterNodes["nodes"][number]["role"]) {
  // Primary stands out because it is the one whose loss means writes stop;
  // everything else is information, not alarm.
  return <Badge variant={role === "primary" ? "default" : "outline"}>{role}</Badge>;
}

function stateBadge(state: ClusterNodes["nodes"][number]["state"]) {
  if (state === "answered") return <Badge variant="outline">answered</Badge>;
  return (
    <Badge variant="destructive">{state === "refused" ? "refused by policy" : "unreachable"}</Badge>
  );
}

export function NodesPanel({ roster, loading }: { roster: ClusterNodes | null; loading: boolean }) {
  if (roster === null || roster.collectedAt === null) {
    if (loading) return null;
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No roster yet</EmptyTitle>
          <EmptyDescription>
            The first collect records which nodes the cluster admits to and whether each answered.
            It runs hourly, and on connect.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const answered = roster.nodes.filter((node) => node.state === "answered").length;
  const total = roster.nodes.length;
  // "4 of 5 members answered" is the sentence this panel exists to say. A
  // roster of one is not a replica set, so it does not pretend to be a count.
  const headline =
    total === 1
      ? `One node (${roster.nodes[0]?.role})`
      : `${answered} of ${total} members answered`;

  return (
    <div>
      <p className="text-sm">
        <span className={answered < total ? "font-medium text-destructive" : "font-medium"}>
          {headline}
        </span>{" "}
        <span className="text-muted-foreground">
          as of <LocalTime iso={roster.collectedAt} options={COLLECTED_AT} />. Hidden members never
          appear — the engine role cannot see them.
        </span>
      </p>
      <ul className="mt-3 space-y-1">
        {roster.nodes.map((node) => (
          <li key={node.host} className="flex flex-wrap items-center gap-2 text-sm">
            <code className="font-mono text-xs">{node.host}</code>
            {roleBadge(node.role)}
            {stateBadge(node.state)}
          </li>
        ))}
      </ul>
    </div>
  );
}
