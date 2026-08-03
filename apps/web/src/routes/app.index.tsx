// The cluster dashboard: reclaimable space, recommendations, latency and the
// per-collection footprint.
//
// Everything here is about ONE cluster. The shell around it — which cluster,
// which org, sign out — belongs to the /app layout, and the org page is its
// own route, so this loader fetches only what this page draws.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { ConnectClusterForm } from "~/components/app/connect-cluster-form";
import { badgeVariant, DeltaCell, dropsOn, fmtBytes, fmtMicros } from "~/components/app/format";
import { PolicySection } from "~/components/app/policy-section";
import { ConfirmButton } from "~/components/confirm-button";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  approveRecommendation,
  loadClusterPolicy,
  loadPipeline,
  loadTelemetry,
  rollbackRecommendation,
  unhideRecommendation,
} from "~/lib/app-server";
import { formatTimestamp, useMounted } from "~/lib/hydration";
import { queryKeys } from "~/lib/query";
import { LineChart, SERIES_PALETTE } from "../components/latency-chart";
import { Route as AppRoute } from "./app";

export const Route = createFileRoute("/app/")({
  loaderDeps: ({ search }: { search: { cluster?: string } }) => ({
    cluster: search.cluster ?? null,
  }),
  // The loader writes through the router's query client, so the server render
  // and the browser cache are one entry. It still fetches on the server, so
  // first paint does not wait for the browser to boot and ask again.
  //
  // ensureQueryData refetches whatever is stale, and staleTime is zero, so a
  // router.invalidate() — connect a cluster, switch one — refreshes all three.
  // A mutation touches only its own key.
  loader: async ({ deps, context }) => {
    const id = deps.cluster;
    await Promise.all([
      context.queryClient.ensureQueryData({
        queryKey: queryKeys.pipeline(id),
        queryFn: () => loadPipeline({ data: id }),
      }),
      context.queryClient.ensureQueryData({
        queryKey: queryKeys.telemetry(id),
        queryFn: () => loadTelemetry({ data: id }),
      }),
      context.queryClient.ensureQueryData({
        queryKey: queryKeys.policy(id),
        queryFn: () => loadClusterPolicy({ data: id }),
      }),
    ]);
    return { clusterId: id };
  },
  head: () => ({ meta: [{ title: "Dashboard — Indexterity" }] }),
  component: Dashboard,
});

// Only reached if the cache were somehow empty; the loader fills it first.
const EMPTY = {
  pipeline: {
    recommendations: [],
    roi: { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0, attribution: [] },
    activity: [],
  },
  telemetry: {
    latency: { collections: [] },
    latencySeries: { collections: [] },
    collectionStats: { collections: [] },
  },
  policy: { policy: null },
};

function Dashboard() {
  const shell = AppRoute.useLoaderData();
  const { clusterId: id } = Route.useLoaderData();
  const queryClient = useQueryClient();
  const mounted = useMounted();

  // The loader already put all three in the cache, so these resolve without
  // suspending. They read rather than fetch.
  // useQuery, not useSuspenseQuery: the loader has already put all three in the
  // cache so there is nothing to wait for, and suspending here would let React
  // hold the previous tree during a navigation that is unmounting this page.
  const { data: pipeline = EMPTY.pipeline } = useQuery({
    queryKey: queryKeys.pipeline(id),
    queryFn: () => loadPipeline({ data: id }),
  });
  const { data: telemetry = EMPTY.telemetry } = useQuery({
    queryKey: queryKeys.telemetry(id),
    queryFn: () => loadTelemetry({ data: id }),
  });
  const { data: policyData = EMPTY.policy } = useQuery({
    queryKey: queryKeys.policy(id),
    queryFn: () => loadClusterPolicy({ data: id }),
  });

  const refetchPipeline = () => queryClient.invalidateQueries({ queryKey: queryKeys.pipeline(id) });

  // Each of these used to end in router.invalidate(), which re-ran every
  // loader on the route to redraw one table.
  const approve = useMutation({
    mutationFn: (recId: string) => approveRecommendation({ data: recId }),
    onSuccess: (result) => {
      if (result.ok) toast.success("Approved — enters the pipeline on the next tick");
      else toast.error("Approve failed — are you an owner, and is the API up?");
      return refetchPipeline();
    },
    onError: () => toast.error("Approve failed — are you an owner, and is the API up?"),
  });
  const unhide = useMutation({
    mutationFn: (recId: string) => unhideRecommendation({ data: recId }),
    onSuccess: (result) => {
      if (result.ok)
        toast.success("Index un-hidden — this drop won't be proposed again for 90 days");
      else toast.error("Could not un-hide — the cluster may be unreachable or read-only");
      return refetchPipeline();
    },
    onError: () => toast.error("Could not un-hide — the cluster may be unreachable or read-only"),
  });
  const undo = useMutation({
    mutationFn: (recId: string) => rollbackRecommendation({ data: recId }),
    onSuccess: (result) => {
      if (result.ok) toast.success("Undo complete — the index was rebuilt");
      else toast.error("Undo failed — the cluster may be unreachable or read-only");
      return refetchPipeline();
    },
    onError: () => toast.error("Undo failed — the cluster may be unreachable or read-only"),
  });

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

  // Merge the index footprint (latest snapshot batch) with the windowed
  // latency summary, keyed by namespace — one row per collection.
  const latencyByNs = new Map(latency.collections.map((c) => [`${c.database}.${c.collection}`, c]));
  const statNs = new Set(collectionStats.collections.map((c) => `${c.database}.${c.collection}`));
  const collectionRows = [
    ...collectionStats.collections.map((stat) => ({
      ns: `${stat.database}.${stat.collection}`,
      stat,
      lat: latencyByNs.get(`${stat.database}.${stat.collection}`) ?? null,
    })),
    ...latency.collections
      .filter((c) => !statNs.has(`${c.database}.${c.collection}`))
      .map((lat) => ({ ns: `${lat.database}.${lat.collection}`, stat: null, lat })),
  ];

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

      <Table className="mt-6">
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Collection</TableHead>
            <TableHead>Index</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Usage</TableHead>
            <TableHead>Rationale</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recommendations.map((rec) => (
            <TableRow key={rec.id}>
              <TableCell>
                <Badge variant={badgeVariant(rec.type)}>{rec.type}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {rec.database}.{rec.collection}
              </TableCell>
              <TableCell className="font-mono text-xs">{rec.indexName}</TableCell>
              <TableCell className="text-xs">
                {rec.score}
                {/* Once a drop is hidden the score is history — it decided
                    whether to start, and the only open question is when this
                    ends. The window is per-index, so it is not something a
                    reader can work out from the policy. */}
                {dropsOn(rec) === null ? null : (
                  <span className="block text-muted-foreground">drops {dropsOn(rec)}</span>
                )}
              </TableCell>
              <TableCell>{rec.usageClass ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{rec.rationale}</TableCell>
              <TableCell>
                {rec.type === "ADVISORY_REVIEW" ? (
                  <span className="text-muted-foreground text-xs">review manually</span>
                ) : rec.state === "PROPOSED" ? (
                  <ConfirmButton
                    trigger={
                      <Button size="sm" variant="secondary">
                        Approve
                      </Button>
                    }
                    title={`Approve ${rec.indexName}?`}
                    description={
                      <>
                        <p>
                          {rec.type.startsWith("DROP") || rec.type === "MERGE"
                            ? "The index is hidden first and observed before anything is dropped — hiding is instant and reversible."
                            : "The index is built and then watched: if writes regress, the build rolls back automatically."}
                        </p>
                        <p className="font-mono text-xs">
                          {rec.database}.{rec.collection} · {rec.indexName}
                        </p>
                      </>
                    }
                    confirmLabel="Approve"
                    onConfirm={() => approve.mutate(rec.id)}
                  />
                ) : rec.state === "DROPPED" ? (
                  <ConfirmButton
                    trigger={
                      <Button size="sm" variant="outline">
                        Undo
                      </Button>
                    }
                    title={`Rebuild ${rec.indexName}?`}
                    description="The index is recreated from the spec recorded at drop time, and the ROI headline is corrected back down."
                    confirmLabel="Rebuild"
                    onConfirm={() => undo.mutate(rec.id)}
                  />
                ) : rec.state === "HIDDEN" ? (
                  <ConfirmButton
                    trigger={
                      <Button size="sm" variant="outline">
                        Keep it
                      </Button>
                    }
                    title={`Cancel the pending drop of ${rec.indexName}?`}
                    description="The index becomes visible to the query planner again straight away, and this drop is not proposed again for 90 days."
                    confirmLabel="Un-hide"
                    onConfirm={() => unhide.mutate(rec.id)}
                  />
                ) : (
                  <span className="text-muted-foreground text-xs">{rec.state}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

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

      {collectionRows.length > 0 ? (
        <>
          <h2 className="mt-8 font-semibold text-lg">Collections</h2>
          <p className="text-muted-foreground text-sm">
            Index footprint from the latest collect; latency is the current windowed average vs the
            first sample (negative Δ = faster).
          </p>
          <Table className="mt-2">
            <TableHeader>
              <TableRow>
                <TableHead>Collection</TableHead>
                <TableHead>Indexes</TableHead>
                <TableHead>Index size</TableHead>
                <TableHead>Read µs</TableHead>
                <TableHead>Read Δ</TableHead>
                <TableHead>Write µs</TableHead>
                <TableHead>Write Δ</TableHead>
                <TableHead>Proposed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collectionRows.map((row) => (
                <TableRow key={row.ns}>
                  <TableCell className="font-mono text-xs">{row.ns}</TableCell>
                  <TableCell>{row.stat?.indexCount ?? "—"}</TableCell>
                  <TableCell>
                    {row.stat === null ? "—" : fmtBytes(row.stat.totalIndexBytes)}
                  </TableCell>
                  <TableCell>{fmtMicros(row.lat?.currentReadMicros ?? null)}</TableCell>
                  <TableCell>
                    <DeltaCell pct={row.lat?.readDeltaPct ?? null} />
                  </TableCell>
                  <TableCell>{fmtMicros(row.lat?.currentWriteMicros ?? null)}</TableCell>
                  <TableCell>
                    <DeltaCell pct={row.lat?.writeDeltaPct ?? null} />
                  </TableCell>
                  <TableCell>
                    {row.stat !== null && row.stat.proposedRecommendations > 0 ? (
                      <Badge variant="secondary">{row.stat.proposedRecommendations}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : null}

      {activity.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-semibold text-lg">Activity</h2>
          <p className="text-muted-foreground text-sm">
            Every executed operation, with its outcome — the immutable audit trail.
          </p>
          <Table className="mt-2">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Op</TableHead>
                <TableHead>Index</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activity.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {formatTimestamp(entry.createdAt, mounted)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{entry.kind}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.database}.{entry.collection} · {entry.indexName}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{entry.actor}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{entry.result}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
      {policy !== null ? (
        <PolicySection
          key={policy.clusterId}
          policy={policy}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: queryKeys.policy(id) })}
        />
      ) : null}
      <ConnectClusterForm />
    </>
  );
}
