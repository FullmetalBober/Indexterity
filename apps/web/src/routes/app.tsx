// The /app shell: who is signed in, which org and cluster are selected, and
// the nav between the pages under it. Everything a signed-in page needs and
// nothing about any one page.
//
// A layout route rather than a single page, so the org page stops paying for
// a cluster's latency series and the dashboard stops paying for the member
// list. Each child fetches what it draws.
import { createFileRoute, Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
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
import { loadAppShell, switchOrgFn } from "~/lib/app-server";
import { signOut } from "../lib/auth";

export const Route = createFileRoute("/app")({
  validateSearch: (search: Record<string, unknown>): { cluster?: string } =>
    typeof search.cluster === "string" ? { cluster: search.cluster } : {},
  loaderDeps: ({ search }) => ({ cluster: search.cluster ?? null }),
  loader: ({ deps }) => loadAppShell({ data: deps.cluster }),
  // Inherits the root's noindex — everything under /app is behind auth.
  head: () => ({ meta: [{ title: "Dashboard — Indexterity" }] }),
  component: AppShell,
});

function AppShell() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();

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
              <Button variant="outline" onClick={() => void router.invalidate()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        </main>
      );
    }
    return <AuthForm onDone={() => router.invalidate()} />;
  }

  const { cluster, clusters, orgs } = data;

  async function onSignOut() {
    await signOut();
    await router.invalidate();
  }

  async function onSwitchOrg(orgId: string) {
    const result = await switchOrgFn({ data: orgId }).catch(() => ({ ok: false, name: null }));
    if (result.ok) toast.success(`Switched to ${result.name ?? "org"}`);
    else toast.error("Org switch failed");
    // The selected cluster belongs to the previous org — reset the selection.
    await navigate({ to: "/app", search: {} });
    await router.invalidate();
  }

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
              onChanged={() => router.invalidate()}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {orgs.length > 1 ? (
            <Select
              value={orgs.find((entry) => entry.active)?.orgId ?? ""}
              onValueChange={(value) => void onSwitchOrg(value)}
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
          <Button variant="outline" size="sm" onClick={() => void onSignOut()}>
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
