import { signInInput, signUpInput } from "@repo/contracts";
import { useRef, useState } from "react";
import { VerifyEmailNotice } from "~/components/app/verify-email-notice";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FieldGroup } from "~/components/ui/field";
import {
  type SecondFactorKind,
  useRequestPasswordReset,
  useSendEmailCode,
  useSignIn,
  useSignUp,
  useVerifySecondFactor,
} from "~/lib/queries/mutations/auth";
import { REQUEST_ACCESS_HREF } from "~/lib/site";

type Mode = "in" | "up" | "forgot" | "code";

const TITLES: Record<Mode, string> = {
  in: "Sign in to your account",
  up: "Create an account",
  forgot: "Reset your password",
  code: "Enter your verification code",
};

const SUBMIT_LABELS: Record<Mode, string> = {
  in: "Sign in",
  up: "Sign up",
  forgot: "Send reset link",
  code: "Verify",
};

// The rules the api enforces, taken off the api's own input schemas rather than
// restated — so the password minimum below is better-auth's minimum, and stays
// that way if it moves. Validated per field: a mode that does not ask for a
// field does not render it, and an unmounted field validates nothing, which is
// how "sign-in needs no name" gets said exactly once.
const EMAIL = signInInput.shape.email;
const PASSWORD = signInInput.shape.password;
const NAME = signUpInput.shape.name;
// Deliberately loose: a TOTP is six digits but a backup code is ten
// characters, and the same field takes both — the api is the judge of a code,
// this only refuses an empty submit.
const TOTP_CODE = ({ value }: { value: string }) =>
  value.trim() === "" ? "Enter the code" : undefined;

const CODE_LABELS: Record<SecondFactorKind, string> = {
  totp: "Authenticator code",
  email: "Emailed code",
  backup: "Backup code",
};

const CODE_HINTS: Record<SecondFactorKind, string> = {
  totp: "The six digits your authenticator app shows right now.",
  email: "The six digits we just sent to your email address.",
  backup: "One of the codes you saved when setting this up. Each works once.",
};

export function AuthForm({ onSignedIn }: { onSignedIn: () => void }) {
  // The address an unconfirmed account belongs to, or null. Set from either
  // endpoint that can answer "confirm first" — sign-up minting no session, or
  // sign-in refused for the same reason — and it replaces the form entirely
  // rather than becoming a fifth mode, because there is nothing left to fill in
  // (#306).
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  // Not a form value: it decides which fields exist, and the reader picks it
  // from a link rather than typing it.
  const [mode, setMode] = useState<Mode>("in");
  // What the api said, which no rule here can predict — a password that passes
  // every check on this page is still the wrong one.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The address of the request in flight. A ref rather than state: nothing
  // renders from it until an answer arrives, so writing it must not re-render.
  const submitted = useRef("");

  // Which kind of second-factor code the reader is about to type. Not a form
  // value — it picks the endpoint, and switching must not clear the field.
  const [factorKind, setFactorKind] = useState<SecondFactorKind>("totp");

  // Shared by all three: clear whatever the last attempt said before making
  // another one.
  const onStart = () => {
    setError(null);
    setNotice(null);
  };
  const credentials = {
    onStart,
    onSignedIn,
    onError: setError,
    // The password was right and the account has a second factor: no session
    // yet, the code is the rest of the sign-in (#55).
    onTwoFactor: () => setMode("code"),
    // The account exists and its address has not been confirmed. Both endpoints
    // can answer this way, so both get it: sign-up by minting no session,
    // sign-in by refusing outright (#306).
    onVerificationRequired: () => setPendingEmail(submitted.current),
  };

  const signIn = useSignIn(credentials);
  const signUp = useSignUp(credentials);
  const verify = useVerifySecondFactor(credentials);
  // Sending mail is a step the reader waits on, so it says so and then says it
  // is done — silence between the click and the inbox is what makes people
  // click twice.
  const sendCode = useSendEmailCode({
    onSent: () => {
      setFactorKind("email");
      setError(null);
      setNotice("Code sent — check your email. It works once, and expires in 5 minutes.");
    },
    onError: setError,
  });
  const forgot = useRequestPasswordReset({
    onStart,
    onSent: () => setNotice("If that email has an account, a reset link is on its way."),
    onError: setError,
  });

  const form = useAppForm({
    defaultValues: { email: "", password: "", name: "", code: "", trustDevice: false },
    onSubmit: ({ value }) => {
      // Remembered before the request, because the answer that needs it does not
      // carry it: better-auth's refusal names no address, and the field may have
      // been reset by the time it lands.
      submitted.current = value.email;
      if (mode === "forgot") forgot.mutate(value.email);
      else if (mode === "in") signIn.mutate({ email: value.email, password: value.password });
      else if (mode === "code")
        verify.mutate({ code: value.code, kind: factorKind, trustDevice: value.trustDevice });
      else signUp.mutate({ email: value.email, password: value.password, name: value.name });
    },
  });

  // Replaces a busy useState that had to be cleared on all four exits from the
  // old submit(), including the ones that returned early.
  const busy = signIn.isPending || signUp.isPending || forgot.isPending || verify.isPending;

  // Switching mode retires the rules the old one applied, so the errors they
  // left have to go too — along with anything the api said about a request that
  // was for a different thing entirely.
  function switchTo(next: Mode) {
    setMode(next);
    onStart();
    form.reset();
  }

  // Nothing on the form applies any more: the account is made and the next move
  // is in an inbox. Rendered in its place rather than above it, so there is no
  // password field inviting another attempt that would be refused the same way.
  if (pendingEmail !== null) {
    return (
      <VerifyEmailNotice
        email={pendingEmail}
        onStartOver={() => {
          setPendingEmail(null);
          switchTo("up");
        }}
      />
    );
  }

  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Indexterity</CardTitle>
          <CardDescription>{TITLES[mode]}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void form.handleSubmit();
            }}
          >
            <FieldGroup className="gap-4">
              {mode === "up" ? (
                <form.AppField name="name" validators={{ onChange: NAME }}>
                  {(field) => <field.TextField label="Name" autoComplete="name" />}
                </form.AppField>
              ) : null}
              {mode !== "code" ? (
                <form.AppField name="email" validators={{ onChange: EMAIL }}>
                  {(field) => <field.TextField label="Email" type="email" autoComplete="email" />}
                </form.AppField>
              ) : null}
              {mode === "in" || mode === "up" ? (
                <form.AppField name="password" validators={{ onChange: PASSWORD }}>
                  {(field) => (
                    <field.TextField
                      label="Password"
                      type="password"
                      autoComplete={mode === "up" ? "new-password" : "current-password"}
                    />
                  )}
                </form.AppField>
              ) : null}
              {mode === "code" ? (
                <>
                  <form.AppField
                    name="code"
                    validators={{ onChange: TOTP_CODE }}
                    // Remount when the kind changes: a backup code is longer
                    // than the other two, and half-typed input from one kind is
                    // noise to the next.
                    key={factorKind}
                  >
                    {(field) => (
                      <field.TextField
                        label={CODE_LABELS[factorKind]}
                        autoComplete="one-time-code"
                        description={CODE_HINTS[factorKind]}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="trustDevice">
                    {(field) => (
                      <field.CheckboxField
                        label="Trust this browser for 30 days"
                        description="You will only be asked for a code on new devices."
                      />
                    )}
                  </form.AppField>
                </>
              ) : null}
            </FieldGroup>
            {error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {error}
                  {/* The api rejected sign-up because this instance is
                      invite-only — say what to do next, not just what failed. */}
                  {error.includes("invite-only") ? (
                    <span className="mt-1 block">
                      Already invited? Use the link from the invite email, or{" "}
                      <a href={REQUEST_ACCESS_HREF} className="underline">
                        request access
                      </a>
                      .
                    </span>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {notice !== null ? (
              <Alert>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : null}
            <form.AppForm>
              <form.SubmitButton pending={busy}>{SUBMIT_LABELS[mode]}</form.SubmitButton>
            </form.AppForm>
          </form>
          <div className="mt-4 flex flex-col items-start gap-1">
            {mode === "code" ? (
              <>
                {factorKind === "totp" ? null : (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => {
                      setFactorKind("totp");
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Use your authenticator app instead
                  </Button>
                )}
                {/* Offered to anyone who has reached this step, since nothing
                    here knows which factor the account enrolled — a deployment
                    with no SMTP answers with its own reason, which is more use
                    than a button that is not there. */}
                {factorKind === "email" ? null : (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    disabled={sendCode.isPending}
                    onClick={() => {
                      setError(null);
                      sendCode.mutate();
                    }}
                  >
                    {sendCode.isPending ? "Sending…" : "Email me a code instead"}
                  </Button>
                )}
                {factorKind === "backup" ? null : (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => {
                      setFactorKind("backup");
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Lost the device? Use a backup code
                  </Button>
                )}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => {
                    setFactorKind("totp");
                    switchTo("in");
                  }}
                >
                  Start over
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => switchTo(mode === "in" ? "up" : "in")}
                >
                  {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
                </Button>
                {mode === "in" ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => switchTo("forgot")}
                  >
                    Forgot password?
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
