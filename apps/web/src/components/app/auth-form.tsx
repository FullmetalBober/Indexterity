import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { requestPasswordReset, signIn, signUp } from "~/lib/auth";
import { REQUEST_ACCESS_HREF } from "~/lib/site";

export function AuthForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"in" | "up" | "forgot">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Both credential paths end the same way, and the only difference between
  // them is which server function is called.
  const credentials = {
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (result: { ok: boolean; error: string | null }) => {
      if (result.ok) onDone();
      else setError(result.error);
    },
    onError: () => setError("authentication failed"),
  };

  const signInMutation = useMutation({
    mutationFn: () => signIn({ data: { email, password } }),
    ...credentials,
  });

  const signUpMutation = useMutation({
    mutationFn: () => signUp({ data: { email, password, name } }),
    ...credentials,
  });

  const forgot = useMutation({
    mutationFn: () => requestPasswordReset({ data: email }),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    // The same answer whether or not the account exists — see the test. Only a
    // failure the api reported is worth showing.
    onSuccess: (sent) => {
      if (sent.ok) setNotice("If that email has an account, a reset link is on its way.");
      else setError(sent.error ?? "request failed");
    },
    onError: () => setError("request failed"),
  });

  // Replaces a busy useState that had to be cleared on all four exits from the
  // old submit(), including the ones that returned early.
  const busy = signInMutation.isPending || signUpMutation.isPending || forgot.isPending;

  function submit() {
    if (mode === "forgot") forgot.mutate();
    else if (mode === "in") signInMutation.mutate();
    else signUpMutation.mutate();
  }

  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Indexterity</CardTitle>
          <CardDescription>
            {mode === "in"
              ? "Sign in to your account"
              : mode === "up"
                ? "Create an account"
                : "Reset your password"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {mode === "up" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="auth-name">Name</Label>
                <Input
                  id="auth-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="auth-email">Email</Label>
              <Input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {mode !== "forgot" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="auth-password">Password</Label>
                <Input
                  id="auth-password"
                  type="password"
                  autoComplete={mode === "up" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            ) : null}
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
            <Button type="submit" disabled={busy}>
              {mode === "in" ? "Sign in" : mode === "up" ? "Sign up" : "Send reset link"}
            </Button>
          </form>
          <div className="mt-4 flex flex-col items-start gap-1">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => setMode(mode === "in" ? "up" : "in")}
            >
              {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
            </Button>
            {mode === "in" ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => setMode("forgot")}
              >
                Forgot password?
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
