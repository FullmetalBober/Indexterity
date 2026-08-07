import type { Cluster, OrgSummary } from "@repo/contracts";
import { Link } from "@tanstack/react-router";
import { DatabaseIcon, LogOutIcon, PlusIcon, Settings2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useSignOut } from "~/lib/queries/mutations/auth";
import { useSwitchOrg } from "~/lib/queries/mutations/org";

// Everything a signed-in reader navigates between, in one rail.
//
// It used to be three underlined tabs — Dashboard, Organization, Account —
// which worked while there were three pages and stopped working the moment a
// cluster became a page of its own. Two reasons the clusters are LISTED here
// rather than picked from a dropdown:
//
//   - A dropdown hides how many you have. The rail answers "what am I
//     responsible for" before you click anything, which is the first question
//     somebody opening this app has.
//   - A select changed a search param; these are links. A cluster is an address
//     now, so it can be bookmarked, opened in a second tab, and linked to from
//     an alert — none of which a dropdown selection can do.
//
// Structural rather than fluid responsiveness (see the Operate notes): a column
// against the left edge from `lg` up, and below that the same links as one
// horizontally scrolling strip. The group labels go rather than wrap, because
// on that strip position already says what they said.
export function AppNav({
  clusters,
  orgs,
}: {
  clusters: readonly Cluster[];
  orgs: readonly OrgSummary[];
}) {
  const signOut = useSignOut();
  const switchOrg = useSwitchOrg();
  const active = orgs.find((entry) => entry.active);

  return (
    <nav
      aria-label="Main"
      className="border-b bg-muted/30 lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0"
    >
      <div className="flex h-full items-center gap-1 overflow-x-auto p-3 lg:flex-col lg:items-stretch lg:overflow-x-visible lg:overflow-y-auto">
        <div className="mr-2 shrink-0 px-2 font-semibold lg:mr-0 lg:mb-1">Indexterity</div>

        {/* Which org, and — only when there is a choice — the switch. One org
            is not a decision, and a select with a single option is a control
            that cannot be used. */}
        {orgs.length > 1 ? (
          <Select value={active?.orgId ?? ""} onValueChange={(value) => switchOrg.mutate(value)}>
            <SelectTrigger
              size="sm"
              className="w-48 shrink-0 lg:w-full"
              aria-label="Switch organization"
            >
              <SelectValue placeholder="Organization" />
            </SelectTrigger>
            <SelectContent>
              {orgs.map((entry) => (
                <SelectItem key={entry.orgId} value={entry.orgId}>
                  {entry.name} ({entry.role})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : active === undefined ? null : (
          // Capped on the strip, where it sits between the product name and the
          // clusters: an org named after a long company pushed every cluster
          // off the right-hand edge of a phone.
          <p className="max-w-40 shrink-0 truncate px-2 text-muted-foreground text-sm lg:mb-1 lg:max-w-none">
            {active.name}
          </p>
        )}

        <GroupLabel>Clusters</GroupLabel>
        {clusters.map((cluster) => (
          <Link
            key={cluster.id}
            to="/app/clusters/$clusterId"
            params={{ clusterId: cluster.id }}
            {...navLink}
          >
            <DatabaseIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{cluster.name}</span>
          </Link>
        ))}
        <Link to="/app/clusters/new" {...navLink}>
          <PlusIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Connect a cluster</span>
        </Link>

        <GroupLabel>Account</GroupLabel>
        <Link to="/app/settings" {...navLink}>
          <Settings2Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Settings</span>
        </Link>

        {/* Pushed to the bottom of the rail, and to the end of the strip: the
            one control here nobody is looking for. */}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0 justify-start text-muted-foreground lg:mt-auto lg:ml-0"
          onClick={() => signOut.mutate()}
        >
          <LogOutIcon aria-hidden="true" className="size-4 shrink-0" />
          Sign out
        </Button>
      </div>
    </nav>
  );
}

// Hidden on the strip, where the links are already grouped by being next to
// each other and a label would cost a whole column of width.
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 hidden px-2 font-medium text-muted-foreground text-xs uppercase tracking-wide lg:block">
      {children}
    </p>
  );
}

// The shared shape of every link in the rail, spread onto `Link` rather than
// wrapped in a component of its own: a wrapper would have to name a union of
// `to` values, which is wider than any one route's params and costs the type
// safety that makes a typed router worth having.
//
// `activeProps` marks the current page for assistive tech as well as in colour —
// the entries are similar enough that colour alone would not distinguish them,
// and on the strip they are identical but for their text.
const navLink = {
  className:
    "flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors lg:mt-0.5",
  activeProps: {
    className: "bg-background font-medium shadow-xs",
    "aria-current": "page",
  },
  inactiveProps: { className: "text-muted-foreground hover:bg-background/60" },
} as const;
