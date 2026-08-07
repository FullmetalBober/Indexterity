import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMounted } from "~/lib/hydration";

interface ClusterIdentity {
  readonly name: string;
  readonly readOnly: boolean;
  readonly provisionedUsername: string | null;
  readonly lastCollectedAt: string | null;
}

// Anything older than this means the numbers on screen predate a gap in
// collection — say so rather than letting them read as current.
const STALE_AFTER_HOURS = 48;

export function staleness(lastCollectedAt: string | null): string | null {
  if (lastCollectedAt === null) return "never collected";
  const hours = (Date.now() - new Date(lastCollectedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours < STALE_AFTER_HOURS) return null;
  const days = Math.floor(hours / 24);
  return days >= 1
    ? `last collected ${days} day${days === 1 ? "" : "s"} ago`
    : `last collected ${Math.floor(hours)}h ago`;
}

// Which cluster this is and whether to believe what is under it.
//
// Everything here is a fact about the cluster; nothing here changes it. That
// split is the point: this used to be one bar holding the name, the badges, a
// cluster dropdown, a mode toggle, a credential form and a disconnect button —
// so "which cluster am I looking at" and "irreversibly change this cluster" sat
// a few pixels apart, above a dashboard that answered neither. Selecting is the
// rail's job now, changing is the cluster's settings page, and what is left is
// the answer to the only question a heading should carry.
export function ClusterHeader({ cluster }: { cluster: ClusterIdentity }) {
  // "How long since we last collected" depends on the reader's clock, so it
  // resolves after hydration rather than differing between the two renders.
  const stale = useMounted() ? staleness(cluster.lastCollectedAt) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="font-semibold text-2xl">{cluster.name}</h1>
      <Badge variant={cluster.readOnly ? "secondary" : "destructive"}>
        {cluster.readOnly ? "read-only" : "live"}
      </Badge>
      {cluster.provisionedUsername !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="font-mono">
              {cluster.provisionedUsername}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Indexterity runs as its own least-privilege user here — it cannot read your documents
          </TooltipContent>
        </Tooltip>
      ) : null}
      {stale !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-amber-500 text-amber-700">
              ⚠ {stale}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            These figures predate a gap in collection. Usage-based drop recommendations are withheld
            until the history is continuous again.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
