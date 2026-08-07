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
    if (data.apiDown) {
      return (
        <main className="mx-auto mt-24 max-w-sm p-8">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Indexterity</CardTitle>
              <CardDescription>The API is unreachable right now.</CardDescription>
            </CardHeader>
            <CardContent>
              {/* This was the one router.invalidate() the app was going to
                  keep, and it cannot be: re-running the loader calls
                  ensureQueryData, which resolves with the cached "api is
                  unreachable" and never asks again. The button would look
                  like a button and do nothing until a full page reload.
                  Refetching the key is what actually retries. */}
              <Button variant="outline" onClick={() => void refetchShell(queryClient)}>
                Retry
              </Button>
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
