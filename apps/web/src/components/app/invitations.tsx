import type { MyInvite } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useAcceptInvite, useRejectInvite } from "~/lib/queries/mutations/org";

// Invitations addressed to the reader, from any org.
//
// This replaces a box you pasted a token into. The token was a bearer
// credential — whoever held the string could join, which made the invite email
// a secret in transit and the paste box a place to spend somebody else's. The
// plugin's invitation is not a secret: accepting requires being signed in as the
// invited address, so the api can simply SHOW you the ones that are yours.
//
// Drawn in two places, because both are moments where joining is the thing you
// came to do: the organization page, and the screen someone with no org at all
// lands on.
export function Invitations({ invites }: { invites: readonly MyInvite[] }) {
  const accept = useAcceptInvite();
  const reject = useRejectInvite();

  if (invites.length === 0) return null;

  return (
    <ul className="space-y-2">
      {invites.map((invite) => (
        <li key={invite.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            <span className="font-medium">{invite.orgName}</span> invited you
          </span>
          <Badge variant="secondary">{invite.role}</Badge>
          <span className="text-muted-foreground text-xs">
            expires {invite.expiresAt.slice(0, 10)}
          </span>
          <Button size="sm" disabled={accept.isPending} onClick={() => accept.mutate(invite.id)}>
            Join
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={reject.isPending}
            onClick={() => reject.mutate(invite.id)}
          >
            Decline
          </Button>
        </li>
      ))}
    </ul>
  );
}
