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
}: ConfirmButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-muted-foreground text-sm">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(destructive && buttonVariants({ variant: "destructive" }))}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
