import { type ReactNode, useState } from "react";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

interface TypeToConfirmProps {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  // What has to be typed out in full. The name of the thing being destroyed,
  // not "DELETE" — a word the dialog supplies is a word muscle memory supplies
  // back, and the point is to make the reader look at WHICH thing this is.
  readonly phrase: string;
  readonly onConfirm: () => void;
}

// ConfirmButton for the actions that cannot be undone AND take other things
// with them.
//
// The difference from ConfirmButton is one input, and it is not ceremony: a
// click-through dialog is answered by the part of you that has answered forty
// of them today. Deleting an organization removes every cluster in it, every
// snapshot behind those, and the record of which least-privilege users we left
// on somebody else's servers. Typing the org's name is the cheapest way to make
// that a decision rather than a reflex.
export function TypeToConfirm({
  trigger,
  title,
  description,
  confirmLabel,
  phrase,
  onConfirm,
}: TypeToConfirmProps) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === phrase;

  return (
    <AlertDialog onOpenChange={(open) => !open && setTyped("")}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-muted-foreground text-sm">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="type-to-confirm">
            Type <span className="font-mono font-semibold">{phrase}</span> to confirm
          </Label>
          <Input
            id="type-to-confirm"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Disabled here, unlike every submit button in this app, and for the
              opposite reason: a form button is enabled so that clicking it
              reveals what is wrong. Nothing is wrong here — the reader has not
              finished saying yes. */}
          <AlertDialogAction
            disabled={!matches}
            onClick={onConfirm}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
