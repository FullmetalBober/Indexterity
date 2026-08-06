import type { MyInvite } from "@repo/contracts";
import { CreateOrgForm } from "~/components/app/create-org-form";
import { Invitations } from "~/components/app/invitations";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";

// What a signed-in reader sees when they belong to no organization.
//
// There was no such screen, because there was no such state: the api inserted
// one called "My Org" behind the first authenticated request, so the first thing
// every account owned was a name nobody had chosen and everybody kept. It is a
// verb now, which means it needs somewhere to be done — and this is also where a
// person who was invited before they signed up finds the invitation, since
// accepting one is the other way to end up in an org.
export function CreateOrgCard({ invites }: { invites: readonly MyInvite[] }) {
  return (
    <Card className="mx-auto mt-16 max-w-lg">
      <CardHeader>
        <CardTitle>Make an organization</CardTitle>
        <CardDescription>
          Clusters, members and your plan all belong to one. Name it after the team or the company —
          you can rename it later, and invite people once it exists.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CreateOrgForm />

        {invites.length > 0 ? (
          <>
            <Separator />
            <p className="text-muted-foreground text-sm">Or join one you have been invited to:</p>
            <Invitations invites={invites} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
