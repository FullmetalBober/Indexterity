// The organization's security trail (#158).
//
// Under Settings rather than beside a cluster, because most of what it records
// has no cluster: signing in and failing to, the second factor, invitations,
// roles. The four acts that DO belong to a cluster — connected, disconnected,
// credentials rotated, mode flipped — are here too, and deliberately not on the
// cluster page: an incident is read as one story about an organization, not
// cluster by cluster.
//
// Not to be confused with the cluster page's Activity table, which is the index
// pipeline: every hide, build, drop and rollback. The two were separated on
// purpose (the schema comment on `security_events` says why).
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SecurityTrailTable } from "~/components/app/security-trail";
import { Unavailable } from "~/components/app/unavailable";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { type TrailFilter, useSecurityEvents } from "~/lib/queries/security";
import { useOrg } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/settings/security")({
  // No loader. Every other tab under Settings reads what the /app layout already
  // warmed; this one is a page-specific read that only owners may make, and
  // warming it in a loader would fire a 403 on navigation for every member who
  // lands here from a link.
  head: () => ({ meta: [{ title: "Security trail — Indexterity" }] }),
  component: SecurityPage,
});

// The cursor is a pair, so it is one piece of state. `null` is the first page,
// which is not the same as "a cursor of nulls" — a filter change has to send the
// reader back to the newest rows rather than to page four of a different query.
interface Cursor {
  readonly createdAt: string;
  readonly id: string;
}

function SecurityPage() {
  const org = useOrg();
  const [filter, setFilter] = useState<{ event?: string; actorUserId?: string }>({});
  const [cursor, setCursor] = useState<Cursor | null>(null);

  const query: TrailFilter = {
    event: filter.event,
    actorUserId: filter.actorUserId,
    beforeCreatedAt: cursor?.createdAt,
    beforeId: cursor?.id,
  };
  const trail = useSecurityEvents(query);

  return (
    <div className="pb-8">
      <h2 className="mt-6 font-semibold text-lg">Security trail</h2>
      <p className="text-muted-foreground text-sm">
        Who did what, from where — sign-ins and failed sign-ins, two-factor, roles and invitations,
        and everything done to a cluster's access. Index operations are on each cluster's Activity
        table instead.
      </p>
      {/* The refusal, said as a refusal. Folded into the empty state it would
          read as "this organization has done nothing", which is a claim about
          the org made because of a role the reader does not hold. */}
      {trail.forbidden ? (
        <Empty className="mt-6">
          <EmptyHeader>
            <EmptyTitle>Owners only</EmptyTitle>
            <EmptyDescription>
              This is who-did-what, and every row carries the address and client a colleague acted
              from. Ask an owner of this organization if you need it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : trail.failed ? (
        /* Same argument as the refusal above, for the other way a read ends with
           nothing (#289). An empty security log is a claim that nothing
           happened, and this is the one table in the product where that claim
           being wrong matters most. */
        <div className="mt-6">
          <Unavailable what="the security trail" onRetry={trail.retry} />
        </div>
      ) : (
        <SecurityTrailTable
          trail={trail.data}
          loading={trail.pending}
          members={org?.members ?? []}
          filter={filter}
          // A new filter is a new question, so it starts at the newest rows. Paging
          // three pages back and then narrowing to failed sign-ins would otherwise
          // land on "page four" of a trail that no longer has four pages.
          onFilter={(next) => {
            setCursor(null);
            setFilter(next);
          }}
          onOlder={() => {
            if (trail.data.nextCreatedAt === null || trail.data.nextId === null) return;
            setCursor({ createdAt: trail.data.nextCreatedAt, id: trail.data.nextId });
          }}
          onNewest={() => setCursor(null)}
          paged={cursor !== null}
        />
      )}
    </div>
  );
}
