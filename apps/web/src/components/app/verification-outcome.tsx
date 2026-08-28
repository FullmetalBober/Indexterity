import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FieldGroup } from "~/components/ui/field";
import { useResendVerification } from "~/lib/queries/mutations/auth";

// What the emailed verification link lands on, once better-auth has consumed the
// token (#324). Before this it landed on `/` — the marketing page, which is
// deliberately static and could therefore report nothing at all. A reader whose
// address was confirmed and one whose link had expired saw the same page and the
// same silence, and the second went on clicking the dead link.
//
// One query parameter is the whole signal, and it has to be: the token is spent,
// there is no session to read, and the api is not consulted from here. On
// success — and on a link opened twice, which better-auth treats the same way
// and so does this, because the address IS confirmed either way — the redirect
// arrives bare. On a failure it carries `?error=<CODE>`.
interface Failure {
  readonly title: string;
  readonly detail: string;
  // Whether another email could help. False where the problem is not the link.
  readonly resend: boolean;
}

const FAILURES: Record<string, Failure> = {
  // The two a reader actually meets. Kept apart rather than merged into "that
  // link did not work", because they differ in whether to suspect your own mail:
  // an expired link was ours and simply sat too long, an invalid one has usually
  // been truncated or rewritten on the way — by a client that wrapped it, or by
  // a scanner that opened it first.
  TOKEN_EXPIRED: {
    title: "That link has expired",
    detail:
      "Verification links do not last forever, and this one is past its date. Ask for a fresh " +
      "one below — it replaces every link sent before it.",
    resend: true,
  },
  INVALID_TOKEN: {
    title: "That link is not valid",
    detail:
      "It may have been cut short or rewritten on its way to you — some mail clients and " +
      "security scanners do that. Copy it from the email in full, or ask for a new one below.",
    resend: true,
  },
  // Neither of these is a link problem, so neither offers a resend: mail to an
  // address with no account would say nothing true, and a mismatch is fixed by
  // signing out rather than by another email.
  USER_NOT_FOUND: {
    title: "There is no account for that address",
    detail:
      "The account may have been deleted since the email was sent. Sign up again if you still " +
      "want one — nothing was confirmed, so nothing is lost.",
    resend: false,
  },
  INVALID_USER: {
    title: "That link is for a different account",
    detail:
      "You are signed in as somebody else in this browser. Sign out, then open the link again.",
    resend: false,
  },
};

// An unknown code is a failure, never a success. better-auth can add codes to
// this endpoint, and the two mistakes do not cost the same: calling a failure
// "confirmed" sends somebody to a sign-in that will refuse them, with the reason
// now nowhere at all.
export function verificationFailure(error: string): Failure | null {
  if (error === "") return null;
  return (
    FAILURES[error] ?? {
      title: "That link did not work",
      detail:
        `The server reported it as ${error}. Ask for a fresh link below, and if the next one ` +
        "does the same, whoever runs this install will find the reason in the logs.",
      resend: true,
    }
  );
}

export function VerificationOutcome({ error }: { readonly error: string }) {
  const failure = verificationFailure(error);
  return failure === null ? <Confirmed /> : <Failed failure={failure} />;
}

function Confirmed() {
  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Email confirmed</CardTitle>
          <CardDescription>Your address is verified. You can sign in now.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Said plainly, because it is the question this page raises and the
              answer is counter-intuitive: confirming from the mailbox does NOT
              sign this browser in. That is deliberate. better-auth will do it
              (autoSignInAfterVerification) and it stays off — a link that minted
              a session would turn a forwarded email, a shared inbox or a mail
              archive into a way into an account that holds the connection
              strings for somebody's databases. The link proves the address; the
              password proves the person. */}
          <p className="text-muted-foreground text-sm">
            Confirming from your inbox does not sign you in here — that still takes your password.
          </p>
          <Link to="/app" className="underline">
            Go to the sign-in page
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}

function Failed({ failure }: { readonly failure: Failure }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useResendVerification({
    onStart: () => {
      setSent(false);
      setError(null);
    },
    onSent: () => setSent(true),
    onError: setError,
  });

  // The address is asked for rather than carried in the URL. better-auth's
  // failure redirect brings only the code, and an email address in a link that
  // gets forwarded and archived is worth not adding. The endpoint behind this is
  // built for exactly this signed-out call: it answers identically for an
  // address it has never seen, on a constant-time floor, so the form cannot be
  // used to find out who has an account here.
  const form = useAppForm({
    defaultValues: { email: "" },
    onSubmit: ({ value }) => send.mutate(value.email),
  });

  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{failure.title}</CardTitle>
          <CardDescription>{failure.detail}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : sent ? (
            // Deliberately non-committal about whether that address has an
            // account: the api refuses to say, and a confident "it is on its
            // way" here would say it for them.
            <Alert>
              <AlertDescription>
                Sent. If an account exists for that address and still needs confirming, a new link
                is on its way.
              </AlertDescription>
            </Alert>
          ) : null}
          {failure.resend ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <FieldGroup className="gap-4">
                <form.AppField name="email">
                  {(field) => <field.TextField label="Email" type="email" autoComplete="email" />}
                </form.AppField>
              </FieldGroup>
              <form.AppForm>
                <form.SubmitButton pending={send.isPending}>
                  {send.isPending ? "Sending…" : "Send a new link"}
                </form.SubmitButton>
              </form.AppForm>
            </form>
          ) : null}
          <Link to="/app" className="underline">
            Back to the sign-in page
          </Link>
          {failure.resend ? (
            // The same sentence the confirm-email notice carries (#306), for the
            // same reason: three a minute is the api's rule, and somebody
            // pressing this a fourth time should read the refusal as a rule
            // rather than as a fault.
            <p className="text-muted-foreground text-xs">
              Three sends a minute. Each link replaces the one before it.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
