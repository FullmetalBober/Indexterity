import type { Cluster } from "@repo/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { FixCommand } from "~/components/app/privilege-list";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useReviewClusterPrivileges, useUpgradeClusterRole } from "~/lib/queries/mutations/cluster";

// Privileges a release added since this cluster's credentials were set up (#599).
//
// A role is created once, from an admin string that is never stored, so a release
// that can use one more action cannot add it to roles already out there. Nothing
// broke — the feature it serves is skipped with a reason — so this is a notice,
// not a warning: default tone, not destructive, and it goes away for good once
// the credentials hold them or the owner says they have seen it.

// Read-only, so the cluster from the list and the connection card's narrower view
// of it both fit.
interface NewPrivileges {
  readonly pending: readonly Readonly<Cluster["newPrivileges"]["pending"][number]>[];
  readonly command: string | null;
  readonly canUpgrade: boolean;
}

function Changes({ pending }: { pending: NewPrivileges["pending"] }) {
  return (
    <ul className="space-y-1">
      {pending.map((change) => (
        <li key={change.key}>
          <span className="font-medium">{change.label}</span>{" "}
          <code className="text-xs">{change.key}</code>
          <span className="text-muted-foreground">
            {" "}
            — new in {change.release}: {change.enables}
          </span>
        </li>
      ))}
    </ul>
  );
}

// On every page of the cluster, above the tabs, beside the blocked-pass banners:
// one line of what is new and where to deal with it. The detail lives on the
// settings page, with the credentials it is about.
export function NewPrivilegesBanner({
  clusterId,
  newPrivileges,
}: {
  clusterId: string;
  newPrivileges: NewPrivileges;
}) {
  if (newPrivileges.pending.length === 0) return null;
  return (
    <Alert className="mt-4">
      <AlertTitle>New privileges Indexterity can use</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          A release since this cluster was connected can do more with privileges its credentials do
          not have. Nothing has stopped working without them.
        </p>
        <Changes pending={newPrivileges.pending} />
        <Link to="/app/clusters/$clusterId/settings" params={{ clusterId }} className="underline">
          Review them in this cluster's settings
        </Link>
      </AlertDescription>
    </Alert>
  );
}

// The settings half: what each one is for, how to grant it, and the two ways to
// be done with the notice — upgrade the role, or say it has been seen.
export function NewPrivilegesSection({
  clusterId,
  newPrivileges,
  onStale,
}: {
  clusterId: string;
  newPrivileges: NewPrivileges;
  onStale: (retry: () => void) => void;
}) {
  const [adminString, setAdminString] = useState("");
  const upgrade = useUpgradeClusterRole(clusterId, {
    onUpgraded: () => setAdminString(""),
    onStale,
  });
  const review = useReviewClusterPrivileges(clusterId);
  if (newPrivileges.pending.length === 0) return null;
  return (
    <section aria-label="New privileges" className="space-y-3 rounded-md border p-3 text-sm">
      <div>
        <p className="font-medium">New privileges Indexterity can use</p>
        <p className="text-muted-foreground">
          Added by a release since these credentials were set up. Each turns on one feature, which
          stays off — with its reason in the activity trail — until it is granted.
        </p>
      </div>
      <Changes pending={newPrivileges.pending} />
      {newPrivileges.command === null ? (
        // #246: a role somebody made by hand has a name we do not know, and a
        // command with a blank in it is the thing that issue removed.
        <p className="text-muted-foreground">
          Add them to the role you created for Indexterity — the connecting guide shows the grant
          for each engine. Checking the credentials above clears this once they hold them.
        </p>
      ) : (
        <div>
          <p className="text-muted-foreground">Run this on the cluster as an admin:</p>
          <FixCommand command={newPrivileges.command} />
        </div>
      )}
      {newPrivileges.canUpgrade ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            upgrade.mutate(adminString);
          }}
        >
          <p className="text-muted-foreground">
            Or let Indexterity do it: an admin string for this cluster is used once to upgrade the
            role it created, and is never stored — the same terms as provisioning.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Admin connection string"
              type="password"
              autoComplete="off"
              className="min-w-72 flex-1 font-mono text-xs"
              placeholder="admin connection string (used once, never stored)"
              value={adminString}
              onChange={(event) => setAdminString(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={upgrade.isPending || adminString === ""}>
              {upgrade.isPending ? "Upgrading…" : "Upgrade role"}
            </Button>
          </div>
        </form>
      ) : null}
      <div>
        <Button
          variant="ghost"
          size="sm"
          disabled={review.isPending}
          onClick={() => review.mutate()}
        >
          {review.isPending ? "Marking…" : "Mark as reviewed"}
        </Button>
        <span className="text-muted-foreground text-xs">
          {" "}
          — not granting them: the notice goes, and nothing changes on the cluster.
        </span>
      </div>
    </section>
  );
}
