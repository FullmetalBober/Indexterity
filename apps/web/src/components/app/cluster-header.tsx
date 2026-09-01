import type { ClusterBlock, TlsOverrides } from "@repo/contracts";
import { blockedBadge, blockedFor } from "~/components/app/cluster-blocked";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMounted } from "~/lib/hydration";
import { millisOf } from "~/lib/instant";

interface ClusterIdentity {
  readonly name: string;
  readonly readOnly: boolean;
  readonly provisionedUsername: string | null;
  readonly lastCollectedAt: string | null;
  readonly tlsOverrides: TlsOverrides;
  readonly blocked: ClusterBlock | null;
}

// Anything older than this means the numbers on screen predate a gap in
// collection — say so rather than letting them read as current.
const STALE_AFTER_HOURS = 48;

// Which certificate checks this cluster was connected with turned off, named the
// way the checkboxes on the connect form name them.
//
// The point of showing them at all: these are chosen once, at a moment when the
// only goal is getting the connection to work, and they are permanent until
// somebody changes them. A concession nobody can see afterwards is one nobody
// reviews — so it sits beside the read-only badge, in the same place the reader
// already looks to find out whether to believe what is underneath.
//
// tlsInsecure is reported ALONE when it is on, because it is a superset: listing
// "certificate not verified" beside it would read as two separate problems where
// there is one broader one.
export function tlsConcessions(overrides: TlsOverrides): string[] {
  if (overrides.insecure) return ["no certificate checks at all"];
  const named: string[] = [];
  if (overrides.allowInvalidCertificates) named.push("certificate not verified");
  if (overrides.allowInvalidHostnames) named.push("hostname not checked");
  return named;
}

export function staleness(lastCollectedAt: string | null): string | null {
  if (lastCollectedAt === null) return "never collected";
  // null means "believe what is underneath", so an instant we cannot read must
  // NOT take that branch: the badge exists to stop old numbers reading as
  // current, and a NaN comparison is false, which is how it silently stopped
  // drawing. Says unknown instead of says fine.
  const collected = millisOf(lastCollectedAt);
  if (collected === null) return "last collected at an unreadable time";
  const hours = (Date.now() - collected) / 3_600_000;
  if (hours < STALE_AFTER_HOURS) return null;
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
  const mounted = useMounted();
  const stale = mounted ? staleness(cluster.lastCollectedAt) : null;
  // Same reason: a duration is the reader's clock against a stored timestamp.
  const blocked = mounted && cluster.blocked !== null ? blockedFor(cluster.blocked.since) : null;
  // Not clock-dependent, so it renders on the server too — unlike staleness.
  const concessions = tlsConcessions(cluster.tlsOverrides);

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
      {concessions.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-amber-500 text-amber-700">
              ⚠ {concessions.join(", ")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            The connection to this cluster is encrypted, but {concessions.join(" and ")} — chosen
            when it was connected. Reconnect it with those boxes cleared to restore the check.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {cluster.blocked !== null ? (
        // Destructive rather than amber, and before the staleness badge: the two
        // are the same story, and this is the half that says why. A reader who
        // sees only "last collected 7 days ago" has to guess between a paused
        // schedule, a quiet cluster and a broken one.
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive">
              ⚠ {blockedBadge(cluster.blocked.reason, cluster.blocked.task)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Collection stopped{blocked === null ? "" : ` ${blocked}`}. The banner under this heading
            says what to do about it.
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
