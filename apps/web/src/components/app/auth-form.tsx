import { signInInput, signUpInput } from "@repo/contracts";
import { useState } from "react";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FieldGroup } from "~/components/ui/field";
import {
  useRequestPasswordReset,
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

export function AuthForm({ onSignedIn }: { onSignedIn: () => void }) {
  // Not a form value: it decides which fields exist, and the reader picks it
  // from a link rather than typing it.
  const [mode, setMode] = useState<Mode>("in");
  // What the api said, which no rule here can predict — a password that passes
  // every check on this page is still the wrong one.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Which kind of second-factor code the reader is about to type. Not a form
  // value — it picks the endpoint, and flipping it must not clear the field.
  const [backupCode, setBackupCode] = useState(false);

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
  };

  const signIn = useSignIn(credentials);
  const signUp = useSignUp(credentials);
  const verify = useVerifySecondFactor(credentials);
  const forgot = useRequestPasswordReset({
    onStart,
    onSent: () => setNotice("If that email has an account, a reset link is on its way."),
    onError: setError,
  });

  const form = useAppForm({
    defaultValues: { email: "", password: "", name: "", code: "", trustDevice: false },
    onSubmit: ({ value }) => {
      if (mode === "forgot") forgot.mutate(value.email);
      else if (mode === "in") signIn.mutate({ email: value.email, password: value.password });
      else if (mode === "code")
        verify.mutate({ code: value.code, backup: backupCode, trustDevice: value.trustDevice });
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
                    // Remount when the kind flips: a backup code is longer than
                    // a TOTP and half-typed input from one kind is noise to the
                    // other.
                    key={backupCode ? "backup" : "totp"}
                  >
                    {(field) => (
                      <field.TextField
                        label={backupCode ? "Backup code" : "Authenticator code"}
                        autoComplete="one-time-code"
                        description={
                          backupCode
                            ? "One of the codes you saved when setting this up. Each works once."
                            : "The six digits your authenticator app shows right now."
                        }
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
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => {
                    setBackupCode(!backupCode);
                    setError(null);
                  }}
                >
                  {backupCode
                    ? "Use your authenticator app instead"
                    : "Lost the device? Use a backup code"}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => {
                    setBackupCode(false);
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
