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
import { ClusterTunnel } from "~/components/app/cluster-tunnel";
import { ObserveSection, ObserveSectionSkeleton } from "~/components/app/observe-section";
import { PolicySection, PolicySectionSkeleton } from "~/components/app/policy-section";
import { Unavailable } from "~/components/app/unavailable";
import { clusterDatabasesQuery, useClusterDatabases } from "~/lib/queries/cluster-databases";
import { policyQuery, usePolicy } from "~/lib/queries/policy";
import { useCluster, useOrg } from "~/lib/queries/shell";

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
  // Read from the org the /app layout already warmed, not fetched here (#313):
  // the connection card needs one boolean to say whether this cluster is out of
  // policy, and a second endpoint per cluster page for one boolean is worse than
  // a field on a payload the shell holds anyway.
  const org = useOrg();

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
          yet — and each now gets its own answer (#289). The failed one used to
          draw nothing, so a reader whose policy would not load saw a page with no
          policy section and no way to tell that from a cluster that has none. */}
      {policy.data !== null ? (
        <PolicySection key={policy.data.clusterId} policy={policy.data} />
      ) : policy.pending ? (
        <PolicySectionSkeleton />
      ) : policy.failed ? (
        <div className="mt-6">
          <Unavailable what="this cluster's policy" onRetry={policy.retry} />
        </div>
      ) : null}
      {/* Above the connection, below the policy: it is a question about this
          cluster's data rather than about its credentials, and unlike the policy
          it can only be answered by asking the cluster. A failed dial still draws
          nothing at all, deliberately, and it is the one read on this page #289
          leaves alone: this failure IS about the cluster, it is the state the
          rotation form underneath exists to fix, and an error panel over the top
          of that form would be describing the problem the form is there to
          solve. */}
      {cluster === null ? null : databases.data !== null ? (
        <ObserveSection key={cluster.id} cluster={cluster} databases={databases.data} />
      ) : databases.pending ? (
        <ObserveSectionSkeleton />
      ) : null}
      {cluster === null ? null : (
        <ClusterTunnel
          clusterId={cluster.id}
          tunnelId={cluster.tunnelId}
          canEdit={org?.role === "owner"}
        />
      )}
      {cluster === null ? null : (
        <ClusterConnection
          cluster={cluster}
          // False while the org read is in flight or failed, deliberately: the
          // only wrong direction here is telling a reader their cluster breaks a
          // rule we have not confirmed is switched on.
          requireLeastPrivilege={org?.policy.requireLeastPrivilege ?? false}
        />
      )}
    </div>
  );
}
