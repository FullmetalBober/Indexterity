// The cluster dashboard: reclaimable space, recommendations, latency and the
// per-collection footprint.
//
// Everything here is about ONE cluster. The shell around it — which cluster,
// which org, sign out — belongs to the /app layout, and the org page is its
// own route, so this loader fetches only what this page draws.
import { createFileRoute } from "@tanstack/react-router";
import { ActivityTable } from "~/components/app/activity-table";
import { CollectionsTable, toCollectionRows } from "~/components/app/collections-table";
import { ConnectClusterForm } from "~/components/app/connect-cluster-form";
import { fmtBytes } from "~/components/app/format";
import { latencyCharts } from "~/components/app/latency-series";
import { PolicySection } from "~/components/app/policy-section";
import { RecommendationsTable } from "~/components/app/recommendations-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useLiveClusterEvents } from "~/lib/queries/live";
import {
  activityQuery,
  recommendationsQuery,
  roiQuery,
  useActivity,
  useRecommendations,
  useRoi,
} from "~/lib/queries/pipeline";
import { policyQuery, usePolicy } from "~/lib/queries/policy";
import { clustersQuery, NO_CLUSTERS, selectCluster, useShell } from "~/lib/queries/shell";
import {
  collectionsQuery,
  latencyQuery,
  latencySeriesQuery,
  useCollections,
  useLatency,
  useLatencySeries,
} from "~/lib/queries/telemetry";
import { LineChart, SERIES_PALETTE } from "../components/latency-chart";

export const Route = createFileRoute("/app/")({
  loaderDeps: ({ search }: { search: { cluster?: string } }) => ({
    cluster: search.cluster ?? null,
  }),
  // The loader writes through the router's query client, and the SSR payload
  // carries that cache into the browser, so the server render and the browser
  // read one entry. First paint does not wait for the browser to boot and ask
  // again.
  //
  // Selecting another cluster changes these keys, so it is the key change that
  // fetches — not this loader re-running. ensureQueryData resolves with cached
  // data whenever there is any, stale or not; what refreshes an already-cached
  // key is a mutation invalidating it, or staleTime lapsing on mount.
  //
  // Which is why the keys are resolved here against the cluster list rather than
  // keyed on the raw search param. "None selected" means the first cluster,
  // and a key of null therefore MEANT one thing before a cluster existed and
  // another after — same entry, two answers, and whichever was cached won.
  // That is a key that lies, and only a zero staleTime constantly refetching
  // was hiding it. A concrete id means the same cluster forever.
  //
  // Same rule as the layout's bar, so the two cannot disagree about which
  // cluster the page is about.
  //
  // Every warm is allowed to fail. The reads no longer fold an error into an
  // empty payload, so a rejection here would take out the whole route instead of
  // the one panel it belongs to; allSettled leaves the error on its own query,
  // where the component reading that query draws an empty panel and the six
  // beside it are unaffected.
  loader: async ({ deps, context }) => {
    const clusters = await context.queryClient
      .ensureQueryData(clustersQuery())
      .catch(() => NO_CLUSTERS);
    const id = selectCluster(clusters, deps.cluster)?.id ?? null;
    await Promise.allSettled([
      context.queryClient.ensureQueryData(recommendationsQuery(id)),
      context.queryClient.ensureQueryData(roiQuery(id)),
      context.queryClient.ensureQueryData(activityQuery(id)),
      context.queryClient.ensureQueryData(latencyQuery(id)),
      context.queryClient.ensureQueryData(latencySeriesQuery(id)),
      context.queryClient.ensureQueryData(collectionsQuery(id)),
      context.queryClient.ensureQueryData(policyQuery(id)),
    ]);
    return { clusterId: id };
  },
  head: () => ({ meta: [{ title: "Dashboard — Indexterity" }] }),
  component: Dashboard,
});

function Dashboard() {
  const shell = useShell();
  const { clusterId: id } = Route.useLoaderData();

  // The live half of everything below: the worker's events for THIS cluster,
  // answered by invalidating the same keys the loader warmed. A worker pass
  // shows up without a reload; switching clusters swaps the subscription with
  // the id.
  useLiveClusterEvents(id);

  // The loader already put each of these in the cache, so they read rather than
  // fetch. useQuery, not useSuspenseQuery: there is nothing to wait for, and
  // suspending here would let React hold the previous tree during a navigation
  // that is unmounting this page. Each hook defaults to empty, so one dead read
  // costs its own panel and nothing else on the page.
  const recommendations = useRecommendations(id);
  const roi = useRoi(id);
  const activity = useActivity(id);
  const latency = useLatency(id);
  const latencySeries = useLatencySeries(id);
  const collectionStats = useCollections(id);
  const policy = usePolicy(id);

  if (!shell.authed) return null;

  const proposed = recommendations.filter((rec) => rec.state === "PROPOSED");
  const totalSaved = proposed.reduce((sum, rec) => sum + rec.estimatedBytesSaved, 0);

  // Ranked per metric, not once for both charts — see latency-series.ts for the bug
  // that made this its own module rather than four lines here.
  const { readSeries, writeSeries, foldedCount } = latencyCharts(latencySeries, SERIES_PALETTE);
  const chartedCount = Math.max(readSeries.length, writeSeries.length);

  // Merged by namespace into one row per collection — see collections-table.tsx,
  // which owns the row shape.
  const collectionRows = toCollectionRows(collectionStats, latency);

  return (
    <>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Proposed reclaimable</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{fmtBytes(totalSaved)}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {proposed.length} recommendation{proposed.length === 1 ? "" : "s"} awaiting review
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Reclaimed</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{fmtBytes(roi.freedBytes)}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {roi.indexesDropped} index{roi.indexesDropped === 1 ? "" : "es"} dropped · $
            {roi.estimatedMonthlyUsd.toFixed(2)}/mo
          </CardContent>
        </Card>
      </div>

      {roi.attribution.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Reclaimed by index</CardTitle>
            <CardDescription>Undone drops are netted out.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {roi.attribution.map((entry) => (
                <li
                  key={entry.recommendationId}
                  className="flex items-baseline justify-between gap-4"
                >
                  <span className="font-mono text-xs">
                    {entry.database}.{entry.collection} · {entry.indexName}
                  </span>
                  <span className="whitespace-nowrap tabular-nums">
                    {fmtBytes(entry.freedBytes)}{" "}
                    <span className="text-muted-foreground text-xs">
                      ~${entry.estimatedMonthlyUsd.toFixed(2)}/mo
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <RecommendationsTable clusterId={id} recommendations={recommendations} />

      {chartedCount > 0 ? (
        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <LineChart title="Read latency" unit="µs/op" series={readSeries} />
          <LineChart title="Write latency" unit="µs/op" series={writeSeries} />
          {foldedCount > 0 ? (
            <p className="text-muted-foreground text-xs md:col-span-2">
              +{foldedCount} more collections — see the table below.
            </p>
          ) : null}
        </section>
      ) : null}

      <h2 className="mt-8 font-semibold text-lg">Collections</h2>
      <p className="text-muted-foreground text-sm">
        Index footprint from the latest collect; latency is the current windowed average vs the
        first sample (negative Δ = faster).
      </p>
      <CollectionsTable rows={collectionRows} />

      <section className="mt-8">
        <h2 className="font-semibold text-lg">Activity</h2>
        <p className="text-muted-foreground text-sm">
          Every executed operation, with its outcome — the immutable audit trail.
        </p>
        <ActivityTable activity={activity} />
      </section>
      {policy !== null ? <PolicySection key={policy.clusterId} policy={policy} /> : null}
      <ConnectClusterForm />
    </>
  );
}
