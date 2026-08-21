import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useResendVerification } from "~/lib/queries/mutations/auth";

// Where a reader lands when the account exists but its address has not been
// confirmed — a sign-up on an install that requires verification, or a sign-in
// refused for the same reason (#306).
//
// This replaced nothing, which was the bug: sign-up answered 200 with no session,
// the form reported it as signed in, and the reader was left on a dashboard whose
// every request answered 401 with no explanation and no way to ask for the mail
// again. The address is named because the most common cause of "it never arrived"
// is that it went to a different one.
export function VerifyEmailNotice({
  email,
  onStartOver,
}: {
  readonly email: string;
  readonly onStartOver: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resend = useResendVerification({
    onStart: () => {
      setSent(false);
      setError(null);
    },
    onSent: () => setSent(true),
    onError: setError,
  });

  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Confirm your email</CardTitle>
          <CardDescription>
            Your account exists. It needs a confirmed address before you can sign in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm">
            We sent a link to <span className="font-medium">{email}</span>. Open it and you are in.
          </p>
          {/* The two reasons a link does not arrive, in the order they actually
              happen. Spam first: the link is sent by whoever runs this install,
              often from an address on a different domain to this one, which is
              exactly what a spam filter is built to distrust. */}
          <p className="text-muted-foreground text-sm">
            Nothing yet? Check the spam folder — the mail comes from whichever address the operator
            of this install configured, which is often not this domain. If the address above is
            wrong, start over: nothing is confirmed, so nothing is lost.
          </p>
          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : sent ? (
            <Alert>
              <AlertDescription>
                Sent again. If it does not arrive this time, the address or the install's mail setup
                is the problem rather than your inbox.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex items-center gap-2">
            <Button onClick={() => resend.mutate(email)} disabled={resend.isPending}>
              {resend.isPending ? "Sending…" : "Send it again"}
            </Button>
            <Button variant="ghost" onClick={onStartOver}>
              Use a different address
            </Button>
          </div>
          {/* Rate limited to three a minute by the api, and saying so is cheaper
              than letting somebody press this four times and read the refusal as
              a fault. */}
          <p className="text-muted-foreground text-xs">
            Three sends a minute. Each link replaces the one before it.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
