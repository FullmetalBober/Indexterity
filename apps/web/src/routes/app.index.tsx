// The cluster dashboard: reclaimable space, recommendations, latency and the
// per-collection footprint.
//
// Everything here is about ONE cluster. The shell around it — which cluster,
// which org, sign out — belongs to the /app layout, and the org page is its
// own route, so this loader fetches only what this page draws.
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ActivityTable } from "~/components/app/activity-table";
import { CollectionsTable, toCollectionRows } from "~/components/app/collections-table";
import { ConnectClusterForm } from "~/components/app/connect-cluster-form";
import { fmtBytes } from "~/components/app/format";
import { PolicySection } from "~/components/app/policy-section";
import { RecommendationsTable } from "~/components/app/recommendations-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { EMPTY_PIPELINE, pipelineQuery } from "~/lib/queries/pipeline";
import { EMPTY_POLICY, policyQuery } from "~/lib/queries/policy";
import { selectCluster, shellQuery, useShell } from "~/lib/queries/shell";
import { EMPTY_TELEMETRY, telemetryQuery } from "~/lib/queries/telemetry";
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
  // Which is why the keys are resolved here against the shell rather than
  // keyed on the raw search param. "None selected" means the first cluster,
  // and a key of null therefore MEANT one thing before a cluster existed and
  // another after — same entry, two answers, and whichever was cached won.
  // That is a key that lies, and only a zero staleTime constantly refetching
  // was hiding it. A concrete id means the same cluster forever.
  //
  // Same rule as the layout's bar, so the two cannot disagree about which
  // cluster the page is about.
  loader: async ({ deps, context }) => {
    const shell = await context.queryClient.ensureQueryData(shellQuery());
    const id = selectCluster(shell.authed ? shell.clusters : [], deps.cluster)?.id ?? null;
    await Promise.all([
      context.queryClient.ensureQueryData(pipelineQuery(id)),
      context.queryClient.ensureQueryData(telemetryQuery(id)),
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

  // The loader already put all three in the cache, so these resolve without
  // suspending. They read rather than fetch.
  // useQuery, not useSuspenseQuery: the loader has already put all three in the
  // cache so there is nothing to wait for, and suspending here would let React
  // hold the previous tree during a navigation that is unmounting this page.
  const { data: pipeline = EMPTY_PIPELINE } = useQuery(pipelineQuery(id));
  const { data: telemetry = EMPTY_TELEMETRY } = useQuery(telemetryQuery(id));
  const { data: policyData = EMPTY_POLICY } = useQuery(policyQuery(id));

  if (!shell.authed) return null;

  const { recommendations, roi, activity } = pipeline;
  const { latency, latencySeries, collectionStats } = telemetry;
  const { policy } = policyData;
  const proposed = recommendations.filter((rec) => rec.state === "PROPOSED");
  const totalSaved = proposed.reduce((sum, rec) => sum + rec.estimatedBytesSaved, 0);

  // Top collections by sample count get the four validated palette slots; the
  // rest fold (color follows the collection across both charts).
  const chartCollections = [...latencySeries.collections]
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, SERIES_PALETTE.length);
  const foldedCount = latencySeries.collections.length - chartCollections.length;
  const readSeries = chartCollections.map((coll, i) => ({
    label: `${coll.database}.${coll.collection}`,
    color: SERIES_PALETTE[i] ?? "#2a78d6",
    points: coll.points.map((point) => ({ t: point.capturedAt, v: point.readMicros })),
  }));
  const writeSeries = chartCollections.map((coll, i) => ({
    label: `${coll.database}.${coll.collection}`,
    color: SERIES_PALETTE[i] ?? "#2a78d6",
    points: coll.points.map((point) => ({ t: point.capturedAt, v: point.writeMicros })),
  }));

  // Merged by namespace into one row per collection — see collections-table.tsx,
  // which owns the row shape.
  const collectionRows = toCollectionRows(collectionStats.collections, latency.collections);

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

      {chartCollections.length > 0 ? (
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
