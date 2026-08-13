// The /app shell: who is signed in, which org is active, and the nav between
// the pages under it. Everything a signed-in page needs and nothing about any
// one page.
//
// A layout route rather than a single page, so the settings pages stop paying
// for a cluster's latency series and a cluster stops paying for the member
// list. Each child fetches what it draws.
//
// It no longer owns which CLUSTER is selected. That was a search param every
// panel keyed its cache on, and a cluster is a page now — see the note in
// lib/queries/keys.ts and the routes under /app/clusters.
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppNav } from "~/components/app/app-nav";
import { AuthForm } from "~/components/app/auth-form";
import { CreateOrgCard } from "~/components/app/create-org-card";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { invalidateSession } from "~/lib/queries/client";
import { useSignOut } from "~/lib/queries/mutations/auth";
import {
  clustersQuery,
  myInvitesQuery,
  orgQuery,
  orgsQuery,
  refetchShell,
  useShell,
} from "~/lib/queries/shell";

export const Route = createFileRoute("/app")({
  // allSettled, because a rejection is an answer here: useShell reads the errors
  // off the queries and draws the sign-in form for a 401 or the unreachable card
  // for anything else. Letting one reject out of the loader would replace both
  // with a route error boundary.
  loader: async ({ context }) => {
    await Promise.allSettled([
      context.queryClient.ensureQueryData(clustersQuery()),
      context.queryClient.ensureQueryData(orgQuery()),
      context.queryClient.ensureQueryData(orgsQuery()),
      context.queryClient.ensureQueryData(myInvitesQuery()),
    ]);
  },
  // Inherits the root's noindex — everything under /app is behind auth.
  head: () => ({ meta: [{ title: "Indexterity" }] }),
  component: AppShell,
});

function AppShell() {
  const data = useShell();
  const queryClient = useQueryClient();
  const signOut = useSignOut();

  if (!data.authed) {
    // Genuinely still finding out, not a failure — the loader's reads had not
    // settled yet. Empty rather than a skeleton: this state is meant to be
    // gone by the time anything paints, and it used to render the same card as
    // a real outage, which is the bug a reader saw as "the API is unreachable"
    // for a beat on a cold, deep-linked visit before the real answer replaced
    // it (found live, not assumed).
    if (data.state === "loading") return null;

    if (data.state === "down") {
      const { status } = data.failure;
      // Three different failures, not one. `null` is the literal, honest
      // "unreachable" — nothing answered, which is the one case that copy was
      // ever true for. A status means the api was reached: 429 is the caller
      // going too fast, not a fault to apologise for, and any other status is
      // a real problem on the api's side that "unreachable" mis-describes as a
      // networking issue on the reader's. The status number is shown on
      // purpose — it costs nothing to leak and is the one fact worth having
      // ready before writing in.
      const description =
        status === 429
          ? "Too many requests right now."
          : status !== null
            ? "Something went wrong loading your account."
            : "The API is unreachable right now.";
      return (
        <main className="mx-auto mt-24 max-w-sm p-8">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Indexterity</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {status === 429 ? (
                <p className="text-muted-foreground text-sm">Wait a moment, then try again.</p>
              ) : null}
              {/* This was the one router.invalidate() the app was going to
                  keep, and it cannot be: re-running the loader calls
                  ensureQueryData, which resolves with the cached failure and
                  never asks again. The button would look like a button and do
                  nothing until a full page reload. Refetching the key is what
                  actually retries. */}
              <Button variant="outline" onClick={() => void refetchShell(queryClient)}>
                Retry
              </Button>
              {status !== null && status !== 429 ? (
                <p className="text-muted-foreground text-xs">
                  Status {status} — if this keeps happening, let us know.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </main>
      );
    }
    // Signing in is a session change like signing out and switching org: every
    // cached answer belonged to whoever was here before.
    return <AuthForm onSignedIn={() => void invalidateSession(queryClient)} />;
  }

  const { clusters, orgs, invites } = data;

  // Signed in and in no organization — a state that did not exist while the api
  // conjured one behind the first request. There is nothing under /app to draw
  // without one: no clusters to list, no plan to spend, no team to be on. Drawn
  // instead of the nav and the outlet, because every link in that nav would go
  // somewhere with the same nothing behind it.
  if (orgs.length === 0) {
    return (
      <main className="p-6 lg:p-8">
        <h1 className="font-semibold text-2xl">Indexterity</h1>
        <CreateOrgCard invites={invites} />
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => signOut.mutate()}>
            Sign out
          </Button>
        </div>
      </main>
    );
  }

  return (
    // No width ceiling on the content column: the pages under it are tables and
    // time series, and both want every pixel. `max-w-4xl` is a reading measure —
    // right for the prose on the landing page, wrong here, where it left 832px
    // for a collections table that wants 1040 and a recommendations table that
    // wants 1168, so the rightmost columns sat outside the viewport at every
    // screen size.
    //
    // `min-w-0` on the column is what makes the rail beside it hold its width:
    // a flex child defaults to its content's minimum, and a table wider than the
    // viewport would otherwise push the whole layout sideways rather than
    // scrolling inside its own box.
    <div className="lg:flex lg:items-start">
      <AppNav clusters={clusters} orgs={orgs} />
      <main className="min-w-0 flex-1 p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}
