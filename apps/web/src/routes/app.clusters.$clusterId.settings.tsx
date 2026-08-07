// One cluster's configuration: what the engine is allowed to do here, and the
// connection it does it with.
//
// Both used to be on the dashboard. A policy is not a measurement, and neither
// is a disconnect button — they were under the ROI cards because that is where
// there was room (#81). Here they are what the page is for, which is also what
// lets them be explained at more than badge length.
import { createFileRoute } from "@tanstack/react-router";
import { ClusterConnection } from "~/components/app/cluster-connection";
import { PolicySection, PolicySectionSkeleton } from "~/components/app/policy-section";
import { policyQuery, usePolicy } from "~/lib/queries/policy";
import { useCluster } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/clusters/$clusterId/settings")({
  // One read, because this page draws one thing the cache does not already hold.
  // The cluster's own row — name, mode, provisioned user — came with the layout
  // above and is not fetched twice.
  loader: async ({ params, context }) => {
    await context.queryClient.ensureQueryData(policyQuery(params.clusterId)).catch(() => null);
  },
  head: () => ({ meta: [{ title: "Cluster settings — Indexterity" }] }),
  component: ClusterSettings,
});

function ClusterSettings() {
  const { clusterId } = Route.useParams();
  const cluster = useCluster(clusterId);
  const policy = usePolicy(clusterId);

  return (
    // Capped, unlike the overview beside it. Everything here is a form, and a
    // "days" box a thousand pixels wide tells a reader it wants a thousand
    // pixels of answer.
    <div className="max-w-3xl">
      {/* Null means three different things — no cluster, a failed read, and not
          yet — and only the last one gets the outline. The first two draw
          nothing, which is the answer the rest of the app gives for a dead
          read. */}
      {policy.data !== null ? (
        <PolicySection key={policy.data.clusterId} policy={policy.data} />
      ) : policy.pending ? (
        <PolicySectionSkeleton />
      ) : null}
      {cluster === null ? null : <ClusterConnection cluster={cluster} />}
    </div>
  );
}
