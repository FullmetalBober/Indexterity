import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useReauthenticate } from "~/lib/queries/mutations/auth";

interface ReauthDialogProps {
  // The retry the api refused with SESSION_NOT_FRESH, re-fired once the
  // password proves the owner is at the keyboard. Null keeps the dialog closed;
  // the dialog closes itself by reporting done.
  readonly retry: (() => void) | null;
  readonly onDone: () => void;
}

// The answer to the api's SESSION_NOT_FRESH refusal (#52): going live, rotating
// credentials and disconnecting demand a sign-in within the last hour, not just
// an owner session — a week-old tab on a borrowed laptop holds one of those and
// not the other. Signing in again mints a fresh session, and the action the
// reader meant to do re-fires on its own rather than making them find the
// button twice.
export function ReauthDialog({ retry, onDone }: ReauthDialogProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setPassword("");
    setError(null);
    onDone();
  };

  const reauth = useReauthenticate({
    onFresh: () => {
      const resume = retry;
      close();
      resume?.();
    },
    onError: setError,
  });

  return (
    <AlertDialog open={retry !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm it's you</AlertDialogTitle>
          <AlertDialogDescription>
            This changes what Indexterity may do to your database, and you signed in a while ago.
            Confirm your password to continue — the action you chose runs right after.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            reauth.mutate(password);
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="reauth-password">Password</Label>
            <Input
              id="reauth-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={password.length === 0 || reauth.isPending}>
              {reauth.isPending ? "Confirming…" : "Confirm"}
            </Button>
          </div>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
