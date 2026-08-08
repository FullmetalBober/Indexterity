// One cluster's overview: reclaimable space, what the engine proposes, latency,
// the per-collection footprint and what has actually been done.
//
// A dashboard, and only a dashboard. The policy form and the connect form used
// to be at the bottom of this page — a page that answers "how is this cluster
// doing" was also where you configured the engine and onboarded the next
// cluster, because that is where there was room. Both are their own routes now
// (#81), and nothing here is a form.
import { createFileRoute } from "@tanstack/react-router";
import { ActivityTable } from "~/components/app/activity-table";
import { CollectionsTable, toCollectionRows } from "~/components/app/collections-table";
import { fmtBytes } from "~/components/app/format";
import { latencyCharts } from "~/components/app/latency-series";
import { NodesPanel } from "~/components/app/nodes-panel";
import { RecommendationsTable } from "~/components/app/recommendations-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  activityQuery,
  recommendationsQuery,
  roiQuery,
  useActivity,
  useRecommendations,
  useRoi,
} from "~/lib/queries/pipeline";
import {
  collectionsQuery,
  latencyQuery,
  latencySeriesQuery,
  nodesQuery,
  useCollections,
  useLatency,
  useLatencySeries,
  useNodes,
} from "~/lib/queries/telemetry";
import { LineChart, SERIES_PALETTE } from "../components/latency-chart";

export const Route = createFileRoute("/app/clusters/$clusterId/")({
  // The loader writes through the router's query client, and the SSR payload
  // carries that cache into the browser, so the server render and the browser
  // read one entry. First paint does not wait for the browser to boot and ask
  // again.
  //
  // Six reads, and only the six this page draws. The policy is not among them
  // any more: it belongs to the settings tab, which warms it in its own loader.
  //
  // No resolving of "which cluster" left to do — the param is the answer, which
  // is what a cluster being a route buys. What it used to cost: the id was
  // resolved here against the cluster list AND again in the component, and a key
  // of null meant "no cluster" before one existed and "the first one" after.
  //
  // Every warm is allowed to fail. The reads no longer fold an error into an
  // empty payload, so a rejection here would take out the whole route instead of
  // the one panel it belongs to; allSettled leaves the error on its own query,
  // where the component reading that query draws an empty panel and the five
  // beside it are unaffected.
  loader: async ({ params, context }) => {
    const id = params.clusterId;
    await Promise.allSettled([
      context.queryClient.ensureQueryData(recommendationsQuery(id)),
      context.queryClient.ensureQueryData(roiQuery(id)),
      context.queryClient.ensureQueryData(activityQuery(id)),
      context.queryClient.ensureQueryData(latencyQuery(id)),
      context.queryClient.ensureQueryData(latencySeriesQuery(id)),
      context.queryClient.ensureQueryData(collectionsQuery(id)),
      context.queryClient.ensureQueryData(nodesQuery(id)),
    ]);
  },
  head: () => ({ meta: [{ title: "Overview — Indexterity" }] }),
  component: ClusterOverview,
});

function ClusterOverview() {
  const { clusterId: id } = Route.useParams();

  // The loader already put each of these in the cache, so they read rather than
  // fetch. useQuery, not useSuspenseQuery: there is nothing to wait for, and
  // suspending here would let React hold the previous tree during a navigation
  // that is unmounting this page. Each answers with its own pending flag, so one
  // dead read costs its own panel and nothing else on the page.
  const recommendations = useRecommendations(id);
  const roi = useRoi(id);
  const activity = useActivity(id);
  const latency = useLatency(id);
  const latencySeries = useLatencySeries(id);
  const collectionStats = useCollections(id);
  const nodes = useNodes(id);

  const proposed = recommendations.data.recommendations.filter((rec) => rec.state === "PROPOSED");
  const totalSaved = proposed.reduce((sum, rec) => sum + rec.estimatedBytesSaved, 0);

  // Ranked per metric, not once for both charts — see latency-series.ts for the bug
  // that made this its own module rather than four lines here.
  const { readSeries, writeSeries, readNote, writeNote } = latencyCharts(
    latencySeries.data.collections,
    SERIES_PALETTE,
  );
  const chartedCount = Math.max(readSeries.length, writeSeries.length);
  // Against the server's denominator, not the payload's length: the api sends
  // the top few by evidence and says how many had readings (#64), so this one
  // number covers both its cut and the chart's own fold to the palette.
  const unchartedCount = Math.max(0, latencySeries.data.totalCollections - chartedCount);

  // Merged by namespace into one row per collection — see collections-table.tsx,
  // which owns the row shape. Two reads behind one table, so it is waiting until
  // both have answered — a table drawn from half its inputs is a table that
  // rewrites itself a moment later.
  const collectionRows = toCollectionRows(collectionStats.data, latency.data);
  const collectionsPending = collectionStats.pending || latency.pending;

  return (
    <>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Proposed reclaimable</CardDescription>
            {/* A measured zero and an unknown look identical as a figure — "0 KB"
                reads as "we looked, there is nothing", which is the same lie the
                empty states were telling (#72). The number waits. */}
            {recommendations.pending ? (
              <Skeleton className="h-9 w-32" />
            ) : (
              <CardTitle className="text-3xl tabular-nums">{fmtBytes(totalSaved)}</CardTitle>
            )}
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {recommendations.pending ? (
              <Skeleton className="h-4 w-52" />
            ) : (
              <>
                {proposed.length} recommendation{proposed.length === 1 ? "" : "s"} awaiting review
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Reclaimed</CardDescription>
            {roi.pending ? (
              <Skeleton className="h-9 w-32" />
            ) : (
              <CardTitle className="text-3xl tabular-nums">
                {fmtBytes(roi.data.freedBytes)}
              </CardTitle>
            )}
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            {roi.pending ? (
              <Skeleton className="h-4 w-52" />
            ) : (
              <>
                {roi.data.indexesDropped} index{roi.data.indexesDropped === 1 ? "" : "es"} dropped ·
                ${roi.data.estimatedMonthlyUsd.toFixed(2)}/mo
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* No skeleton: a cluster with nothing dropped yet has no such card at
          all, so drawing an outline for it would promise a panel that may never
          arrive — which is the same content-shift, only in the other direction. */}
      {roi.data.attribution.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Reclaimed by index</CardTitle>
            <CardDescription>Undone drops are netted out.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {roi.data.attribution.map((entry) => (
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

      <RecommendationsTable
        clusterId={id}
        recommendations={recommendations.data.recommendations}
        total={recommendations.data.total}
        loading={recommendations.pending}
      />

      {/* Drawn while the series read is out, because two charts appearing under
          the recommendations table is the single biggest jump on this page.

          A cluster with no latency history at all still draws nothing rather than
          two empty boxes. One that HAS history and nothing plottable now keeps the
          boxes and says why: a panel that renders nothing and a panel that cannot
          be measured looked identical from outside, and that is what got #85 filed
          against a chart that was working. */}
      {latencySeries.pending || chartedCount > 0 || latencySeries.data.collections.length > 0 ? (
        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <LineChart
            title="Read latency"
            unit="µs/op"
            series={readSeries}
            pending={latencySeries.pending}
            emptyNote={readNote}
          />
          <LineChart
            title="Write latency"
            unit="µs/op"
            series={writeSeries}
            pending={latencySeries.pending}
            emptyNote={writeNote}
          />
          {unchartedCount > 0 ? (
            <p className="text-muted-foreground text-xs md:col-span-2">
              +{unchartedCount} more collections had readings — see the table below.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="font-semibold text-lg">Nodes</h2>
        <p className="text-muted-foreground text-sm">
          Every member the last collect saw. Usage and latency are summed across the ones that
          answered — a member that did not answer is a blind spot, not a zero.
        </p>
        <div className="mt-3">
          <NodesPanel roster={nodes.data} loading={nodes.pending} />
        </div>
      </section>

      <h2 className="mt-8 font-semibold text-lg">Collections</h2>
      <p className="text-muted-foreground text-sm">
        Index footprint from the latest collect; latency is the current windowed average vs the
        first sample (negative Δ = faster).
      </p>
      <CollectionsTable rows={collectionRows} loading={collectionsPending} />

      <section className="mt-8">
        <h2 className="font-semibold text-lg">Activity</h2>
        <p className="text-muted-foreground text-sm">
          Every executed operation, with its outcome — the immutable audit trail.
        </p>
        <ActivityTable activity={activity.data} loading={activity.pending} />
      </section>
    </>
  );
}
