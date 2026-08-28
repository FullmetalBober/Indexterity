// One cluster, as an address.
//
// This is the layout every cluster-scoped page hangs off: it settles WHICH
// cluster, draws the heading that says so, and subscribes to that cluster's live
// events. What it deliberately does not do is fetch anything a page below it
// draws — the overview reads six things and the settings page reads one, and
// neither should pay for the other's.
//
// The id being in the path is most of the point of #81. It used to be
// `?cluster=…`, resolved against the cluster list by every panel and by the bar
// separately, which is how those two came to disagree (#82). A path parameter is
// concrete before anything reads it, so a cluster-scoped cache key cannot be
// keyed on "whichever is first" any more (see lib/queries/keys.ts).
import { createFileRoute, Link, Navigate, Outlet, redirect } from "@tanstack/react-router";
import { ClusterBlockedBanner } from "~/components/app/cluster-blocked";
import { ClusterHeader } from "~/components/app/cluster-header";
import { useLiveClusterEvents } from "~/lib/queries/live";
import { clustersQuery, useCluster, useShell } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/clusters/$clusterId")({
  loader: async ({ params, context }) => {
    // A failure is not a redirect: the layout above draws the sign-in form for a
    // 401 and the retry card for anything else, and both are better answers than
    // bouncing somebody off a URL they meant to open.
    const clusters = await context.queryClient.ensureQueryData(clustersQuery()).catch(() => null);
    if (clusters === null) return;
    // An id this org does not own. Three ways to arrive here and one right
    // answer for all of them: guessing another tenant's id, following a link to
    // a cluster since disconnected, and being here when the org switched
    // underneath. /app then decides where "nothing selected" goes.
    if (!clusters.some((cluster) => cluster.id === params.clusterId)) {
      throw redirect({ to: "/app" });
    }
  },
  component: ClusterLayout,
});

const TAB = "-mb-px border-b-2 border-transparent px-1 pb-2";
const TAB_ACTIVE = { className: "border-primary font-medium", "aria-current": "page" as const };
const TAB_INACTIVE = { className: "text-muted-foreground hover:text-foreground" };

function ClusterLayout() {
  const { clusterId } = Route.useParams();
  const shell = useShell();
  const cluster = useCluster(clusterId);

  // The worker's events for THIS cluster, answered by invalidating the same keys
  // the pages below read. A worker pass shows up without a reload, on whichever
  // of the two pages is open, and moving between clusters swaps the
  // subscription with the route.
  useLiveClusterEvents(clusterId);

  // The loader's redirect covers arriving at an id this org does not own. It
  // cannot cover the id ceasing to be owned while the page is open — the cluster
  // list refetches without re-running any loader (see invalidateSession), which
  // is disconnecting this cluster, switching org, and being removed from one.
  // Deriving it from the live list is what makes all four one answer, and it is
  // the same lesson as #82.
  if (shell.authed && cluster === null) return <Navigate to="/app" replace />;
  // Not yet, or could not ask. The layout above draws both.
  if (cluster === null) return null;

  return (
    <>
      <ClusterHeader cluster={cluster} />
      {cluster.blocked === null ? null : (
        <ClusterBlockedBanner clusterId={clusterId} block={cluster.blocked} />
      )}
      <nav aria-label="Cluster" className="mt-4 mb-6 flex gap-4 border-b text-sm">
        <Link
          to="/app/clusters/$clusterId"
          params={{ clusterId }}
          activeOptions={{ exact: true }}
          activeProps={TAB_ACTIVE}
          inactiveProps={TAB_INACTIVE}
          className={TAB}
        >
          Overview
        </Link>
        <Link
          to="/app/clusters/$clusterId/settings"
          params={{ clusterId }}
          activeProps={TAB_ACTIVE}
          inactiveProps={TAB_INACTIVE}
          className={TAB}
        >
          Settings
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
