import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { resetPassword } from "../lib/auth";

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
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = useMutation({
    mutationFn: () => resetPassword({ data: { token, newPassword: password } }),
    onMutate: () => setError(null),
    onSuccess: (result) => {
      if (result.ok) setDone(true);
      else setError(result.error ?? "reset failed");
    },
    onError: () => setError("reset failed"),
  });

  function submit() {
    // Checked here rather than by the api, which only ever sees one password.
    if (password !== confirm) {
      setError("passwords don't match");
      return;
    }
    reset.mutate();
  }

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
              submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="confirm-password">Repeat it</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            {error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={reset.isPending || password.length === 0}>
              Set password
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
