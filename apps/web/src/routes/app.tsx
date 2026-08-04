// The /app shell: who is signed in, which org and cluster are selected, and
// the nav between the pages under it. Everything a signed-in page needs and
// nothing about any one page.
//
// A layout route rather than a single page, so the org page stops paying for
// a cluster's latency series and the dashboard stops paying for the member
// list. Each child fetches what it draws.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
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
import { switchOrgFn } from "~/lib/app-server";
import { invalidateSession, queryKeys } from "~/lib/query";
import { shellQuery, useShell } from "~/lib/shell";
import { signOut } from "../lib/auth";

export const Route = createFileRoute("/app")({
  validateSearch: (search: Record<string, unknown>): { cluster?: string } =>
    typeof search.cluster === "string" ? { cluster: search.cluster } : {},
  // No loaderDeps: the shell does not depend on which cluster is selected, so
  // selecting another one must not re-run this. The child route's loader is
  // keyed on the selection and refetches on its own.
  loader: ({ context }) => context.queryClient.ensureQueryData(shellQuery()),
  // Inherits the root's noindex — everything under /app is behind auth.
  head: () => ({ meta: [{ title: "Dashboard — Indexterity" }] }),
  component: AppShell,
});

function AppShell() {
  const data = useShell();
  const { cluster: selected } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Signing out and switching org both replace the session the whole cache was
  // an answer to — see invalidateSession. Signing in, below, is the third.
  const signOutMutation = useMutation({
    mutationFn: () => signOut(),
    // onSettled, not onSuccess: after an attempt at signing out, whether the
    // cookie is gone is the server's answer to give, not ours to assume.
    onSettled: () => invalidateSession(queryClient),
  });

  const switchOrg = useMutation({
    mutationFn: (orgId: string) => switchOrgFn({ data: orgId }),
    onSuccess: async (result) => {
      if (!result.ok) {
        // Nothing moved, so nothing is refetched and the selection stays.
        toast.error("Org switch failed");
        return;
      }
      toast.success(`Switched to ${result.name ?? "org"}`);
      // The selected cluster belongs to the previous org — reset the selection.
      await navigate({ to: "/app", search: {} });
      await invalidateSession(queryClient);
    },
    onError: () => toast.error("Org switch failed"),
  });

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
              <Button
                variant="outline"
                onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.shell() })}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        </main>
      );
    }
    return <AuthForm onDone={() => void invalidateSession(queryClient)} />;
  }

  const { clusters, orgs } = data;
  // Which of them is on screen comes from the URL, not from the shell: the
  // shell says what exists, and "none selected" means the first one.
  const cluster = clusters.find((entry) => entry.id === selected) ?? clusters[0] ?? null;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-semibold text-2xl">Indexterity</h1>
          {cluster === null ? (
            <p className="mt-1 text-muted-foreground">No cluster connected</p>
          ) : (
            <ClusterBar
              cluster={cluster}
              clusters={clusters}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: queryKeys.shell() })}
            />
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
          <Button variant="outline" size="sm" onClick={() => signOutMutation.mutate()}>
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
