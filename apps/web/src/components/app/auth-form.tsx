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
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    if (mode === "forgot") {
      const sent = await requestPasswordReset({ data: email }).catch(() => ({
        ok: false,
        error: "request failed",
      }));
      setBusy(false);
      if (sent.ok) setNotice("If that email has an account, a reset link is on its way.");
      else setError("error" in sent ? sent.error : "request failed");
      return;
    }
    const result =
      mode === "in"
        ? await signIn({ data: { email, password } })
        : await signUp({ data: { email, password, name } });
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.error);
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
              void submit();
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
