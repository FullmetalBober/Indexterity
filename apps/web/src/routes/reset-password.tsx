import { resetPasswordInput } from "@repo/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FieldGroup } from "~/components/ui/field";
import { useResetPassword } from "../lib/queries/mutations/auth";

// Landing page for the emailed reset link: better-auth's callback redirects
// here with ?token=, and the new password is submitted with that token.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  // Inherits the root's noindex — a reset link must never reach an index.
  head: () => ({ meta: [{ title: "Reset your password — Indexterity" }] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = useResetPassword(token, {
    onStart: () => setError(null),
    onDone: () => setDone(true),
    onError: setError,
  });

  const form = useAppForm({
    defaultValues: { password: "", confirm: "" },
    onSubmit: ({ value }) => reset.mutate(value.password),
  });

  if (token === "") {
    return (
      <main className="mx-auto mt-24 max-w-sm p-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Indexterity</CardTitle>
            <CardDescription>
              This page needs the reset link from your email. Request one from the{" "}
              <Link to="/app" className="underline">
                sign-in page
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  if (done) {
    return (
      <main className="mx-auto mt-24 max-w-sm p-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Password updated</CardTitle>
            <CardDescription>
              You can now{" "}
              <Link to="/app" className="underline">
                sign in with the new password
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Choose a new password</CardTitle>
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
              <form.AppField
                name="password"
                validators={{ onChange: resetPasswordInput.shape.password }}
              >
                {(field) => (
                  <field.TextField
                    label="New password"
                    type="password"
                    autoComplete="new-password"
                  />
                )}
              </form.AppField>
              <form.AppField
                name="confirm"
                validators={{
                  // The api never sees this one — it is sent a single password —
                  // so the match is only ever checked here. onChangeListenTo
                  // re-runs it when the first field moves, so fixing a typo in
                  // the password clears the mismatch instead of stranding it.
                  onChangeListenTo: ["password"],
                  onChange: ({ value, fieldApi }) =>
                    value === fieldApi.form.getFieldValue("password")
                      ? undefined
                      : "The two do not match",
                }}
              >
                {(field) => (
                  <field.TextField label="Repeat it" type="password" autoComplete="new-password" />
                )}
              </form.AppField>
            </FieldGroup>
            {error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <form.AppForm>
              <form.SubmitButton pending={reset.isPending}>Set password</form.SubmitButton>
            </form.AppForm>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
