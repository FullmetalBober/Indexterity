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
import { useMe } from "~/lib/queries/account";
import { useReauthenticate, useReauthenticateSecondFactor } from "~/lib/queries/mutations/auth";

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
//
// An account with a second factor owes a code after the password (#55) — the
// dialog grows a second step rather than bouncing through the sign-in page,
// and never offers "trust this device": freshness exists to prove presence
// now, which is the one thing a remembered device does not.
export function ReauthDialog({ retry, onDone }: ReauthDialogProps) {
  const me = useMe();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState(false);
  const [step, setStep] = useState<"password" | "code">("password");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setPassword("");
    setCode("");
    setBackupCode(false);
    setStep("password");
    setError(null);
    onDone();
  };

  const onFresh = () => {
    const resume = retry;
    close();
    resume?.();
  };
  const activeOrgId = me?.session.activeOrganizationId ?? null;

  const reauth = useReauthenticate({
    onFresh,
    onError: setError,
    onTwoFactor: () => {
      setError(null);
      setStep("code");
    },
  });
  const verify = useReauthenticateSecondFactor({ onFresh, onError: setError });

  return (
    <AlertDialog open={retry !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm it's you</AlertDialogTitle>
          <AlertDialogDescription>
            {step === "password"
              ? "This changes what Indexterity may do to your database, and you signed in a " +
                "while ago. Confirm your password to continue — the action you chose runs " +
                "right after."
              : backupCode
                ? "Enter one of your backup codes. Each works once."
                : "Enter the six digits your authenticator app shows right now."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (step === "password") {
              if (me === null) {
                setError("your session has ended — sign in again");
                return;
              }
              reauth.mutate({ email: me.user.email, password, activeOrgId });
            } else {
              verify.mutate({ code, backup: backupCode, activeOrgId });
            }
          }}
        >
          {step === "password" ? (
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
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="reauth-code">
                {backupCode ? "Backup code" : "Authenticator code"}
              </Label>
              <Input
                id="reauth-code"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto self-start p-0"
                onClick={() => {
                  setBackupCode(!backupCode);
                  setCode("");
                  setError(null);
                }}
              >
                {backupCode
                  ? "Use your authenticator app instead"
                  : "Lost the device? Use a backup code"}
              </Button>
            </div>
          )}
          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                (step === "password" ? password.length === 0 : code.length === 0) ||
                reauth.isPending ||
                verify.isPending
              }
            >
              {reauth.isPending || verify.isPending ? "Confirming…" : "Confirm"}
            </Button>
          </div>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
