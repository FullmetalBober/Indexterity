import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface ConfirmButtonProps {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  /**
   * The mutation is in flight, so the trigger is blocked and says so.
   *
   * These are the irreversible actions — disconnecting a cluster deletes every
   * snapshot it ever had — and they had no pending state at all: the dialog
   * closed on confirm and the trigger came straight back, live, while the request
   * was still going. A second press was a second request, and for a disconnect
   * the second one answers "no such cluster": an error about the reader's own
   * successful action.
   */
  readonly pending?: boolean;
  /** What the action says while it waits. Defaults to the label plus an ellipsis. */
  readonly pendingLabel?: string;
}

// Every irreversible or cluster-affecting action goes through this instead of
// window.confirm: the consequences are worth more than one line of chrome, and
// the dialog can show the exact command or state involved.
export function ConfirmButton({
  trigger,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  pending = false,
  pendingLabel,
}: ConfirmButtonProps) {
  return (
    // The dialog closes on confirm, as it always has. Holding it open to show
    // progress meant switching Radix between uncontrolled and controlled
    // mid-life, which it does not support — so the waiting is shown on the
    // TRIGGER, which is what the reader is looking at once the dialog is gone.
    <AlertDialog>
      <AlertDialogTrigger asChild disabled={pending}>
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-muted-foreground text-sm">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            // Belt and braces: the trigger is already blocked while this runs, so
            // reaching this in a pending state means the dialog was reopened
            // somehow. Refusing costs nothing and a second irreversible act costs
            // a great deal.
            disabled={pending}
            className={cn(destructive && buttonVariants({ variant: "destructive" }))}
          >
            {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
