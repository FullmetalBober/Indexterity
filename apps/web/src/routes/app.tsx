// The /app shell: who is signed in, which org and cluster are selected, and
// the nav between the pages under it. Everything a signed-in page needs and
// nothing about any one page.
//
// A layout route rather than a single page, so the org page stops paying for
// a cluster's latency series and the dashboard stops paying for the member
// list. Each child fetches what it draws.
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { AuthForm } from "~/components/app/auth-form";
import { ClusterBar } from "~/components/app/cluster-bar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { invalidateSession } from "~/lib/queries/client";
import { useSignOut } from "~/lib/queries/mutations/auth";
import { useSwitchOrg } from "~/lib/queries/mutations/org";
import {
  clustersQuery,
  orgQuery,
  orgsQuery,
  refetchShell,
  selectCluster,
  useShell,
} from "~/lib/queries/shell";

export const Route = createFileRoute("/app")({
  validateSearch: (search: Record<string, unknown>): { cluster?: string } =>
    typeof search.cluster === "string" ? { cluster: search.cluster } : {},
  // No loaderDeps: none of these three depend on which cluster is selected, so
  // selecting another one must not re-run this. The child route's loader is
  // keyed on the selection and refetches on its own.
  //
  // allSettled, because a rejection is an answer here: useShell reads the errors
  // off the queries and draws the sign-in form for a 401 or the unreachable card
  // for anything else. Letting one reject out of the loader would replace both
  // with a route error boundary.
  loader: async ({ context }) => {
    await Promise.allSettled([
      context.queryClient.ensureQueryData(clustersQuery()),
      context.queryClient.ensureQueryData(orgQuery()),
      context.queryClient.ensureQueryData(orgsQuery()),
    ]);
  },
  // Inherits the root's noindex — everything under /app is behind auth.
  head: () => ({ meta: [{ title: "Dashboard — Indexterity" }] }),
  component: AppShell,
});

function AppShell() {
  const data = useShell();
  const { cluster: selected } = Route.useSearch();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const switchOrg = useSwitchOrg();

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

  const { clusters, orgs } = data;
  const cluster = selectCluster(clusters, selected);

  return (
    // No width ceiling: the page is nothing but tables and time series, and both
    // want every pixel. `max-w-4xl` is a reading measure — right for the prose on the
    // landing page, wrong here, where it left 832px for a collections table that
    // wants 1040 and a recommendations table that wants 1168, so the rightmost
    // columns sat outside the viewport at every screen size. The padding is the only
    // inset now.
    //
    // The cost is real on a very wide monitor: a row a metre long is a row you track
    // with a finger. Two things keep it honest — the tables set their column widths
    // as proportions, so the slack lands mostly on the namespace rather than
    // stretching the numbers, and every table stays sorted by the column that
    // matters, so the answer is at the top rather than at the far right.
    <main className="p-6 lg:p-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-semibold text-2xl">Indexterity</h1>
          {cluster === null ? (
            <p className="mt-1 text-muted-foreground">No cluster connected</p>
          ) : (
            <ClusterBar cluster={cluster} clusters={clusters} />
          )}
        </div>
        <div className="flex items-center gap-2">
          {orgs.length > 1 ? (
            <Select
              value={orgs.find((entry) => entry.active)?.orgId ?? ""}
              onValueChange={(value) => switchOrg.mutate(value)}
            >
              <SelectTrigger size="sm" className="w-55" aria-label="Switch organization">
                <SelectValue placeholder="Organization" />
              </SelectTrigger>
              <SelectContent>
                {orgs.map((entry) => (
                  <SelectItem key={entry.orgId} value={entry.orgId}>
                    {entry.name} ({entry.role})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => signOut.mutate()}>
            Sign out
          </Button>
        </div>
      </div>

      {/* activeProps marks the current page for assistive tech, not only in
          colour — the two links look similar enough that colour alone would
          not distinguish them. */}
      <nav aria-label="Dashboard sections" className="mt-4 flex gap-4 border-b text-sm">
        <Link
          to="/app"
          activeOptions={{ exact: true }}
          activeProps={{
            className: "border-primary border-b-2 font-medium",
            "aria-current": "page",
          }}
          inactiveProps={{ className: "text-muted-foreground" }}
          className="-mb-px px-1 pb-2"
        >
          Dashboard
        </Link>
        <Link
          to="/app/org"
          activeProps={{
            className: "border-primary border-b-2 font-medium",
            "aria-current": "page",
          }}
          inactiveProps={{ className: "text-muted-foreground" }}
          className="-mb-px px-1 pb-2"
        >
          Organization
        </Link>
      </nav>

      <Outlet />
    </main>
  );
}
