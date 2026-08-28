import type { MyInvite, OrgSummary } from "@repo/contracts";
import { CreateOrgForm } from "~/components/app/create-org-form";
import { Invitations } from "~/components/app/invitations";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useSwitchOrg } from "~/lib/queries/mutations/org";

// Every organization the reader belongs to, could belong to, or could start.
//
// This page exists because "Start another organization" was on the page ABOUT
// one organization, under its member list, below a delete button for it (#81).
// Making a new org is not a fact about the org you are in — it is a fact about
// the set of them, which is what this page is. The invitations addressed to you
// are the other way into that set, so they are here too rather than filed under
// somebody else's team.
export function OrgList({
  orgs,
  invites,
}: {
  orgs: readonly OrgSummary[];
  invites: readonly MyInvite[];
}) {
  const switchOrg = useSwitchOrg();

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">You belong to</CardTitle>
          <CardDescription>
            {/* Worth stating, because it surprises people who have the app open
                twice: which org is active is a property of this session, not of
                the account. */}
            Which one is active is per browser session, so two windows can sit in two different
            organizations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1">
            {orgs.map((entry) => (
              <li key={entry.orgId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{entry.name}</span>
                <Badge variant="outline">{entry.role}</Badge>
                {entry.active ? (
                  <Badge variant="secondary">active</Badge>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={switchOrg.isPending}
                    onClick={() => switchOrg.mutate(entry.orgId)}
                  >
                    Switch to it
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {invites.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Invitations</CardTitle>
            <CardDescription>Addressed to you, from any organization.</CardDescription>
          </CardHeader>
          <CardContent>
            <Invitations invites={invites} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Start another organization</CardTitle>
          <CardDescription>
            {/* There is no cap: a plan is bought per org, so limiting how many
                you may make would limit how much you may buy. Not owner-only
                either — a member of somebody else's org may still start their
                own. */}
            Clusters, members and a plan all belong to one organization. A second one shares nothing
            with this one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrgForm label="Name" submitLabel="Create organization" />
        </CardContent>
      </Card>
    </>
  );
}
