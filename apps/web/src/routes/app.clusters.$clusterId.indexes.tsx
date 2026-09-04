// Every index this cluster has (#431), and under it every scanning query shape
// the engine saw (#432). What the page is FOR — and why it is two tables that
// share a subject and nothing else — is the header of
// components/app/indexes-page.tsx, which is the page. This file is the route:
// the loader, and the wrapper that hands the page its cluster.
import { createFileRoute } from "@tanstack/react-router";
import { ClusterIndexesPage, INVENTORY_VIEW, WORKLOAD_VIEW } from "~/components/app/indexes-page";
import { firstPage } from "~/lib/paged-view";
import { clusterIndexesQuery, clusterWorkloadQuery, nodesQuery } from "~/lib/queries/telemetry";

export const Route = createFileRoute("/app/clusters/$clusterId/indexes")({
  // Three reads, warmed and not awaited in the browser — the same rule as the two
  // tabs beside it (D117). The roster is the second because the usage column is
  // only honest with it: "3 of 5 nodes" needs to know there are five, and a
  // member the collect never reached must be NAMED rather than counted as a
  // zero.
  //
  // Only the FIRST page of each table is warmed, and under the request the
  // component makes on mount — `firstPage` of the same view the component is
  // built from — rather than under `{}` (#455). The api answers both the same
  // way; the cache does not. The request IS the key, so a warm-up that asks with
  // fewer fields fills an entry the component never reads, and the tab draws a
  // skeleton on every SSR. Any other page is state the reader creates by
  // clicking, so warming it would be prefetching a page nobody has asked for.
  loader: async ({ params, context }) => {
    const id = params.clusterId;
    const warm = Promise.allSettled([
      context.queryClient.ensureQueryData(clusterIndexesQuery(id, firstPage(INVENTORY_VIEW))),
      context.queryClient.ensureQueryData(nodesQuery(id)),
      context.queryClient.ensureQueryData(clusterWorkloadQuery(id, firstPage(WORKLOAD_VIEW))),
    ]);
    if (import.meta.env.SSR) await warm;
  },
  head: () => ({ meta: [{ title: "Indexes — Indexterity" }] }),
  component: ClusterIndexesRoute,
});

function ClusterIndexesRoute() {
  const { clusterId } = Route.useParams();
  return <ClusterIndexesPage clusterId={clusterId} />;
}
