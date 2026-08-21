import type { ClusterPrivileges, PrivilegeCheck } from "@repo/contracts";
import { FixCommand, Row } from "~/components/app/privilege-list";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

// What the credentials a cluster is stored on actually hold, in three groups
// (#313).
//
// The posture badge above this panel says `admin credentials`, which is true and
// is not actionable: it says these credentials can do more than manage indexes
// and never says WHAT more, so the one thing a reader wants to do about it —
// revoke the surplus grant — has no target on screen. That is the same rule #86
// settled one card along: "cannot" and "could not tell" must not be the same
// pixels. This is that rule applied to surplus.
//
// The three groups and why they are three:
//
//   provided    what this credential holds. Reassurance, and the frame for the
//               other two — a list of gaps means nothing without it.
//   required    what the engine needs HERE, per engine and per observed scope.
//               A gap is a fault; an ungranted WORKLOAD row is a signal that is
//               simply unavailable, which is why the marks differ.
//   redundant   held, never used, with the statement that removes it. The one
//               group that is a to-do list.
//
// `provided` is derived rather than sent: it is the granted rows of the other
// two, and sending each row twice would be two places for one fact.

// How old the figures are, in words a reader can act on. The panel dials on
// demand, so this is nearly always "just now" — and the exception is the case
// that matters, a panel left open while somebody rotated the string in another
// tab.
function ageOf(checkedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(checkedAt).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// A surplus row's polarity is the reverse of every other check's: `granted: true`
// is the finding, and the command REVOKES rather than grants. So it cannot go
// through `Row`, which draws a tick for granted and reads `command` as a fix.
function SurplusRow({ privilege }: { privilege: PrivilegeCheck }) {
  return (
    <li className="flex gap-2">
      {/* Not a red ✗ and not a green ✓. A surplus grant is not broken — the
          cluster works, the analysis runs — and it is not fine either. The
          reader is being told about something they may want to take away, which
          is an advisory, so it is marked like one. */}
      <span className="text-amber-600 dark:text-amber-500">!</span>
      <span>
        <span className="font-medium">{privilege.label}</span>
        <span className="text-muted-foreground"> — {privilege.enables}</span>
        {privilege.command == null || privilege.command === "" ? null : (
          <FixCommand command={privilege.command} />
        )}
      </span>
    </li>
  );
}

export function CredentialPrivileges({
  privileges,
  now = Date.now(),
}: {
  readonly privileges: ClusterPrivileges;
  // Injected so the age line is testable without freezing the clock.
  readonly now?: number;
}) {
  if (!privileges.reachable) {
    // Its own panel and not an empty state. "We could not ask this cluster" and
    // "this cluster holds nothing surplus" are the two answers that must never
    // render alike (#289) — and the second is the reassuring one, so a failed
    // read drawn as emptiness reads as a clean bill of health.
    return (
      <Alert variant="destructive" className="mt-3">
        <AlertTitle>Could not re-check these credentials</AlertTitle>
        <AlertDescription>
          {privileges.message ??
            "The cluster did not answer. Nothing below is a statement about what these credentials hold."}
        </AlertDescription>
      </Alert>
    );
  }

  const provided = [...privileges.required, ...privileges.surplus].filter((check) => check.granted);

  return (
    <div className="mt-3 space-y-4 rounded-md border p-3 text-sm">
      <p className="text-muted-foreground text-xs">
        Asked of the cluster {ageOf(privileges.checkedAt, now)}, as{" "}
        <code>{privileges.username ?? (privileges.authEnabled ? "unknown" : "no auth")}</code>.
      </p>

      <div>
        <p className="font-medium text-xs">Provided</p>
        <p className="text-muted-foreground text-xs">What the stored credentials hold right now.</p>
        {/* Granted rows only, so this list cannot be empty while the cluster is
            reachable — a credential with nothing granted could not have answered
            the probe. The guard is here anyway, because "reachable and nothing
            granted" is a shape a future adapter could produce and blank space is
            the wrong way to say it. */}
        {provided.length === 0 ? (
          <p className="mt-1 text-muted-foreground text-xs">
            The cluster answered and reported no privileges at all, which is not a state these
            credentials should be able to reach — check the row below for what is missing.
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-xs">
            {provided.map((check) => (
              <li key={check.key} className="flex gap-2">
                <span className="text-primary">✓</span>
                <span>{check.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="font-medium text-xs">Required</p>
        <p className="text-muted-foreground text-xs">
          What the engine needs on this cluster, for the databases it observes.
        </p>
        <ul className="mt-1 space-y-0.5 text-xs">
          {privileges.required.map((check) => (
            // WORKLOAD rows are optional: an absent signal source is a path that
            // is unavailable, not a fault, and the same distinction the connect
            // form draws.
            <Row key={check.key} privilege={check} optional={check.tier === "WORKLOAD"} />
          ))}
        </ul>
      </div>

      <div>
        <p className="font-medium text-xs">Redundant</p>
        {/* The empty group SAYS it is empty, which is the issue's second
            constraint and the whole of #289: nothing surplus is the reassuring
            answer, and blank space does not deliver reassurance — it reads as a
            panel that failed to load. A provisioned user reaches this branch
            every time by construction. */}
        {privileges.surplus.length === 0 ? (
          <p className="mt-1 text-muted-foreground text-xs">
            Nothing. These credentials hold no privilege the engine does not use — there is nothing
            here to revoke.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              Held and never used. Revoking these changes nothing about what Indexterity can do
              here.
            </p>
            <ul className="mt-1 space-y-1.5 text-xs">
              {privileges.surplus.map((check) => (
                <SurplusRow key={check.key} privilege={check} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// The panel's own trigger, states and retry, so the connection card stays a list
// of things you can do to a cluster rather than a place that also manages a
// query.
export function CredentialPrivilegesPanel({
  open,
  onOpen,
  read,
}: {
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly read: {
    readonly data: ClusterPrivileges | null;
    readonly pending: boolean;
    readonly failed: boolean;
    readonly retry: () => void;
  };
}) {
  return (
    <div>
      <Button variant="outline" size="sm" onClick={onOpen}>
        {open ? "Hide privileges" : "Check what these credentials hold"}
      </Button>
      <p className="mt-2 text-muted-foreground text-sm">
        Dials the cluster and asks it, so the answer is about the credentials stored now — not the
        ones connected on day one.
      </p>
      {!open ? null : read.data !== null ? (
        <CredentialPrivileges privileges={read.data} />
      ) : read.pending ? (
        <p className="mt-3 text-muted-foreground text-xs">Asking the cluster…</p>
      ) : read.failed ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Could not reach this cluster</AlertTitle>
          <AlertDescription className="grid justify-items-start gap-2">
            <span>
              Nothing below is a statement about what these credentials hold. Rotating the string
              below still works.
            </span>
            <Button variant="outline" size="sm" onClick={read.retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
