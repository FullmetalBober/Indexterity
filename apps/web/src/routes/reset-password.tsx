import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { resetPassword } from "../lib/auth";

// Landing page for the emailed reset link: better-auth's callback redirects
// here with ?token=, and the new password is submitted with that token.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (password !== confirm) {
      setError("passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await resetPassword({ data: { token, newPassword: password } }).catch(() => ({
      ok: false,
      error: "reset failed",
    }));
    setBusy(false);
    if (result.ok) setDone(true);
    else setError(("error" in result ? result.error : null) ?? "reset failed");
  }

  if (token === "") {
    return (
      <main className="mx-auto mt-24 max-w-sm p-8">
        <h1 className="font-semibold text-2xl">Indexterity</h1>
        <p className="mt-2 text-muted-foreground">
          This page needs the reset link from your email. Request one from the{" "}
          <Link to="/app" className="underline">
            sign-in page
          </Link>
          .
        </p>
      </main>
    );
  }

  if (done) {
    return (
      <main className="mx-auto mt-24 max-w-sm p-8">
        <h1 className="font-semibold text-2xl">Password updated</h1>
        <p className="mt-2 text-muted-foreground">
          You can now{" "}
          <Link to="/app" className="underline">
            sign in with the new password
          </Link>
          .
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <h1 className="font-semibold text-2xl">Choose a new password</h1>
      <form
        className="mt-6 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="rounded-md border px-3 py-2 text-sm"
          type="password"
          placeholder="New password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <input
          className="rounded-md border px-3 py-2 text-sm"
          type="password"
          placeholder="Repeat it"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {error ? <p className="text-red-600 text-sm">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="rounded-md bg-primary px-3 py-2 text-primary-foreground text-sm disabled:opacity-50"
        >
          Set password
        </button>
      </form>
    </main>
  );
}
