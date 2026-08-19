import type { OrgMember, SecurityEvent, SecurityTrail } from "@repo/contracts";
import { SECURITY_EVENTS } from "@repo/contracts";
import { eventLabel, eventLine } from "~/components/app/security-event";
import { Truncated } from "~/components/truncated";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { LocalTime } from "~/lib/hydration";

// The security trail: 23 kinds of act, recorded since #53 and read by nothing
// until #158.
//
// Not a DataTable. That primitive sorts and filters over what ARRIVED, which is
// D33's deliberate client-side behaviour and exactly wrong here: this is one
// page of a table that never ages out, so a client-side filter would search a
// hundred rows and report "nothing matches" about a trail of forty thousand.
// The filters go to the api, and the paging is a keyset cursor.

// The option value for "no filter". A Select cannot hold an empty string as a
// value, and null is not one either.
const ANY = "__any__";

// The same shape the roster uses, and the same reason it is a component: a
// timestamp formatted in the reader's zone cannot be server-rendered as text.
const WHEN: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

function toneClass(tone: ReturnType<typeof eventLine>["tone"]): string {
  if (tone === "attempt") return "text-amber-700";
  if (tone === "severe") return "font-medium";
  return "";
}

function Row({ event }: { event: SecurityEvent }) {
  const line = eventLine(event);
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-3 align-top whitespace-nowrap text-muted-foreground text-xs tabular-nums">
        <LocalTime iso={event.createdAt} options={WHEN} />
      </td>
      <td className="py-2 pr-3 align-top">
        <span className={`text-sm ${toneClass(line.tone)}`}>{line.label}</span>
      </td>
      <td className="py-2 pr-3 align-top text-sm">
        {/* An unproven actor is drawn as an absence, not as a name. Rendering
            the typed address in this column would say the account holder did
            it, and in the row worth reading they are who it was done TO. */}
        {line.actor === null ? (
          <span className="text-muted-foreground text-xs">—</span>
        ) : (
          <Truncated className="text-sm">{line.actor}</Truncated>
        )}
      </td>
      <td className="py-2 pr-3 align-top text-muted-foreground text-sm">
        {line.subject === null ? null : <Truncated className="text-sm">{line.subject}</Truncated>}
      </td>
      <td className="py-2 align-top text-muted-foreground text-xs">
        {/* Null rather than wrong when the address cannot be established: the api
            reads a forwarded header only where TRUST_PROXY says a proxy is in
            front, so an install without one records nothing here rather than a
            column full of the proxy's own address. */}
        {event.ipAddress === null ? (
          <span>not recorded</span>
        ) : (
          <Truncated className="font-mono text-xs" full={event.userAgent ?? event.ipAddress}>
            {event.ipAddress}
          </Truncated>
        )}
      </td>
    </tr>
  );
}

export function SecurityTrailTable({
  trail,
  loading,
  members,
  filter,
  onFilter,
  onOlder,
  onNewest,
  paged,
}: {
  trail: SecurityTrail;
  loading: boolean;
  // The org's current members, for the actor picker. Already in the cache — the
  // /app layout reads the org for the rail and the plan meter. Somebody who has
  // since left the org is not in here and cannot be picked; their rows are still
  // in the trail, and still say who they were, because the email is stored
  // beside the id for exactly that.
  members: readonly OrgMember[];
  filter: { event?: string | undefined; actorUserId?: string | undefined };
  onFilter: (next: { event?: string | undefined; actorUserId?: string | undefined }) => void;
  onOlder: () => void;
  onNewest: () => void;
  // Whether the reader has paged away from the newest rows. The "newest" button
  // is not offered on the first page, where it would do nothing.
  paged: boolean;
}) {
  const showing = trail.events.length;
  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-end gap-3">
        {/* A div and an aria-label, not a <label>: the trigger a Select renders
            is a button, and a label may only name a form control. The visible
            caption above it and the accessible name on the trigger say the same
            thing, so a screen reader and a sighted reader get one answer. */}
        <div className="text-sm">
          <span className="block text-muted-foreground text-xs">Kind</span>
          <Select
            value={filter.event ?? ANY}
            onValueChange={(value) =>
              onFilter({ ...filter, event: value === ANY ? undefined : value })
            }
          >
            <SelectTrigger className="mt-1 w-64" aria-label="Filter by kind">
              <SelectValue placeholder="Any kind" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any kind</SelectItem>
              {SECURITY_EVENTS.map((name) => (
                <SelectItem key={name} value={name}>
                  {eventLabel(name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="text-sm">
          <span className="block text-muted-foreground text-xs">Actor</span>
          <Select
            value={filter.actorUserId ?? ANY}
            onValueChange={(value) =>
              onFilter({ ...filter, actorUserId: value === ANY ? undefined : value })
            }
          >
            <SelectTrigger className="mt-1 w-64" aria-label="Filter by actor">
              <SelectValue placeholder="Anyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Anyone</SelectItem>
              {members.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <Skeleton className="mt-4 h-64 w-full" />
      ) : showing === 0 ? (
        <Empty className="mt-4">
          <EmptyHeader>
            <EmptyTitle>Nothing recorded</EmptyTitle>
            <EmptyDescription>
              {filter.event === undefined && filter.actorUserId === undefined
                ? "Sign-ins, membership changes and everything done to a cluster's access are recorded here from the moment they happen. Nothing yet means nothing has."
                : "No acts of this kind by this person. The trail itself is not empty — clear the filters to see it."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <p className="mt-4 text-muted-foreground text-sm">
            {/* The total is of what MATCHES the filter, so this sentence stays
                true when one is applied. A page saying "100 of 4,312" while
                filtered to failed sign-ins would be counting the whole trail. */}
            {showing === trail.total
              ? `${trail.total.toLocaleString()} ${trail.total === 1 ? "act" : "acts"}`
              : `Showing ${showing} of ${trail.total.toLocaleString()} acts, newest first.`}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">The organization's security trail</caption>
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    When
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Act
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Actor
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Subject
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    From
                  </th>
                </tr>
              </thead>
              <tbody>
                {trail.events.map((event) => (
                  <Row key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center gap-2">
            {paged ? (
              <Button size="sm" variant="outline" onClick={onNewest}>
                Newest
              </Button>
            ) : null}
            {/* Offered only when the api said there IS a next page. Paging into
                an empty one to discover the end is how a reader concludes the
                trail stops where it does not. */}
            {trail.nextId === null ? (
              <span className="text-muted-foreground text-xs">
                {paged ? "The end of the trail." : null}
              </span>
            ) : (
              <Button size="sm" variant="outline" onClick={onOlder}>
                Older
              </Button>
            )}
          </div>
        </>
      )}
      <p className="mt-6 text-muted-foreground text-xs">
        <Badge variant="outline">Owner only</Badge> Every row carries the address and client a
        colleague acted from. A failed sign-in has no actor — the address shown is the one that was
        typed, and nobody proved they were that person.
      </p>
    </section>
  );
}
