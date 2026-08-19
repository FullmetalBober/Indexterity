// One cluster's configuration: what the engine is allowed to do here, and the
// connection it does it with.
//
// Both used to be on the dashboard. A policy is not a measurement, and neither
// is a disconnect button — they were under the ROI cards because that is where
// there was room (#81). Here they are what the page is for, which is also what
// lets them be explained at more than badge length.
import { createFileRoute } from "@tanstack/react-router";
import { ClusterConnection } from "~/components/app/cluster-connection";
import { ClusterName } from "~/components/app/cluster-name";
import { ObserveSection, ObserveSectionSkeleton } from "~/components/app/observe-section";
import { PolicySection, PolicySectionSkeleton } from "~/components/app/policy-section";
import { clusterDatabasesQuery, useClusterDatabases } from "~/lib/queries/cluster-databases";
import { policyQuery, usePolicy } from "~/lib/queries/policy";
import { useCluster } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/clusters/$clusterId/settings")({
  // Two reads now (#244), and only one of them is cheap. The database list dials
  // the customer's cluster, so it is prefetched in parallel rather than after the
  // policy — and its failure is swallowed the same way, because a cluster that
  // cannot be reached must still render a settings page. That is where the
  // connection string is rotated.
  loader: async ({ params, context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(policyQuery(params.clusterId)).catch(() => null),
      context.queryClient
        .ensureQueryData(clusterDatabasesQuery(params.clusterId))
        .catch(() => null),
    ]);
  },
  head: () => ({ meta: [{ title: "Cluster settings — Indexterity" }] }),
  component: ClusterSettings,
});

function ClusterSettings() {
  const { clusterId } = Route.useParams();
  const cluster = useCluster(clusterId);
  const policy = usePolicy(clusterId);
  const databases = useClusterDatabases(clusterId);

  return (
    // Capped, unlike the overview beside it. Everything here is a form, and a
    // "days" box a thousand pixels wide tells a reader it wants a thousand
    // pixels of answer.
    <div className="max-w-3xl">
      {/* First, because it is the cheapest thing on the page to understand and
          the one that was impossible until #96. Keyed by the cluster: the field
          holds a name being edited, and switching clusters must not carry the
          previous one's into it. */}
      {cluster === null ? null : <ClusterName key={cluster.id} cluster={cluster} />}
      {/* Null means three different things — no cluster, a failed read, and not
          yet — and only the last one gets the outline. The first two draw
          nothing, which is the answer the rest of the app gives for a dead
          read. */}
      {policy.data !== null ? (
        <PolicySection key={policy.data.clusterId} policy={policy.data} />
      ) : policy.pending ? (
        <PolicySectionSkeleton />
      ) : null}
      {/* Above the connection, below the policy: it is a question about this
          cluster's data rather than about its credentials, and unlike the policy
          it can only be answered by asking the cluster. A failed dial draws
          nothing at all — the page's job then is the rotation form underneath. */}
      {cluster === null ? null : databases.data !== null ? (
        <ObserveSection key={cluster.id} cluster={cluster} databases={databases.data} />
      ) : databases.pending ? (
        <ObserveSectionSkeleton />
      ) : null}
      {cluster === null ? null : <ClusterConnection cluster={cluster} />}
    </div>
  );
}
