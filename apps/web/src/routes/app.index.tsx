// /app is an address people type, bookmark and get mailed. It is not a page any
// more — every page under it is about one cluster or about settings — so this
// route's whole job is deciding which of those the reader meant.
//
// A redirect rather than "the dashboard for the first cluster", because those
// two are not the same thing: the second leaves the URL saying nothing about
// what is on screen, which is the search-param selection this redesign removed.
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { clustersQuery, orgsQuery, useShell } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/")({
  loader: async ({ context }) => {
    // Both allowed to fail, and a failure is NOT a redirect. A 401 or an
    // unreachable api means the layout above is about to draw the sign-in form
    // or the retry card — sending a signed-out visitor to /app/clusters/new
    // would leave them looking at a sign-in form under a URL about connecting a
    // cluster, and their address bar would have lost where they were going.
    const [orgs, clusters] = await Promise.all([
      context.queryClient.ensureQueryData(orgsQuery()).catch(() => null),
      context.queryClient.ensureQueryData(clustersQuery()).catch(() => null),
    ]);
    if (orgs === null || clusters === null) return;
    // Same reasoning for belonging to no org: the layout draws the create
    // screen, and there is nothing under any of these addresses until it is
    // answered.
    if (orgs.length === 0) return;

    const first = clusters[0];
    throw redirect(
      first === undefined
        ? // Nothing connected. Connecting one is not a fallback here, it is the
          // only thing there is to do — see the note on that route.
          { to: "/app/clusters/new" }
        : { to: "/app/clusters/$clusterId", params: { clusterId: first.id } },
    );
  },
  component: AppIndex,
});

// The same decision again, off the live cluster list.
//
// Not belt and braces — the loader alone cannot answer this. Making an
// organization does not navigate: it invalidates the session cache, the layout
// above stops drawing the create screen and starts drawing this outlet, and no
// loader re-runs (see invalidateSession). Somebody who had just made their first
// org therefore landed on the blank page this route renders when it does not
// redirect. Deriving it from the query means a cache change is enough, which is
// the same lesson as #82.
//
// The loader is still the one that matters for a cold navigation: it redirects
// before anything renders, so there is no flash of this page on the way through.
function AppIndex() {
  const shell = useShell();
  // Both of the states this could be are drawn by the layout instead of the
  // outlet, so reaching here at all means signed in and in an organization.
  if (!shell.authed) return null;
  const first = shell.clusters[0];
  return first === undefined ? (
    <Navigate to="/app/clusters/new" replace />
  ) : (
    <Navigate to="/app/clusters/$clusterId" params={{ clusterId: first.id }} replace />
  );
}
