import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";

// What a panel draws when its read FAILED, as opposed to when it came back
// empty (#289).
//
// Those were the same thing on screen, and the empty states are written to
// reassure — "Nothing to review means nothing is obviously wrong" over a cluster
// with fifty-one live proposals, because the endpoint was 500ing. That is D19's
// rule ("cannot tell" is never spelled "all clear") holding in the pipeline and
// broken in the browser, and it is worse here than a blank panel would be: a
// blank panel invites a question, and a reassuring one closes it.
//
// Two rules for the copy, and they are the whole design:
//
//   Say whose problem it is. A reader looking at their own database has every
//   reason to think a failure is about the cluster. It is not — the cluster was
//   never dialled — and saying so is what stops this becoming a support ticket
//   about a healthy server.
//
//   Claim nothing about the data. No counts, no "0", no "none found". The only
//   honest statement available is that we do not know.

// The panel-sized one, for a slot that would otherwise hold an empty state.
export function Unavailable({
  what,
  onRetry,
}: {
  // Named from the reader's side — "recommendations", "the parked list" — and
  // completes "We could not load ___ for this cluster."
  what: string;
  onRetry: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Could not load {what}</EmptyTitle>
        <EmptyDescription>
          Something went wrong on our side, so this is not a finding about your cluster — nothing
          was read from it. Whatever is here is unchanged.
        </EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Empty>
  );
}

// The inline one, for a stat card's figure.
//
// An em dash rather than a zero, for the reason the pending skeleton beside it
// already exists: "0 KB" reads as "we looked, there is nothing" — a measurement
// — and a failed read took no measurement. The route draws this in place of both
// the number and its caption, so the caption cannot go on counting either.
export function UnavailableFigure({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      {/* Decorative, and hidden from assistive tech on purpose: the dash is
          there so the card does not collapse, and the sentence below carries the
          actual meaning. An aria-label reading "unavailable" would announce it
          twice. */}
      <span className="text-3xl text-muted-foreground tabular-nums" aria-hidden="true">
        —
      </span>
      <span className="text-muted-foreground text-sm">
        Could not load this.{" "}
        <button type="button" onClick={onRetry} className="underline underline-offset-2">
          Try again
        </button>
      </span>
    </>
  );
}
