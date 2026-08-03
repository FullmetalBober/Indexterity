// The dashboard page: what it shows and how the pieces fit together.
// Its sections live in ~/components/app and its server functions in
// ~/lib/app-server, so this file stays about the page.

import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { AuthForm } from "~/components/app/auth-form";
import { ClusterBar } from "~/components/app/cluster-bar";
import { ConnectClusterForm } from "~/components/app/connect-cluster-form";
import { badgeVariant, DeltaCell, dropsOn, fmtBytes, fmtMicros } from "~/components/app/format";
import { PolicySection } from "~/components/app/policy-section";
import { TeamSection } from "~/components/app/team-section";
import { ConfirmButton } from "~/components/confirm-button";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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
  loadDashboard,
  rollbackRecommendation,
  switchOrgFn,
  unhideRecommendation,
} from "~/lib/app-server";
import { formatTimestamp, useMounted } from "~/lib/hydration";
import { LineChart, SERIES_PALETTE } from "../components/latency-chart";
import { signOut } from "../lib/auth";

export const Route = createFileRoute("/app")({
  validateSearch: (search: Record<string, unknown>): { cluster?: string } =>
    typeof search.cluster === "string" ? { cluster: search.cluster } : {},
  loaderDeps: ({ search }) => ({ cluster: search.cluster ?? null }),
  loader: ({ deps }) => loadDashboard({ data: deps.cluster }),
  // Inherits the root's noindex — the dashboard is behind auth.
  head: () => ({ meta: [{ title: "Dashboard — Indexterity" }] }),
  component: Home,
});

function Home() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const mounted = useMounted();

  if (!data.authed) {
    if (data.apiDown) {
      return (
        <main className="mx-auto mt-24 max-w-sm p-8">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Indexterity</CardTitle>
              <CardDescription>The API is unreachable right now.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void router.invalidate()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        </main>
      );
    }
    return <AuthForm onDone={() => router.invalidate()} />;
  }

  const {
    cluster,
    clusters,
    recommendations,
    roi,
    latency,
    latencySeries,
    collectionStats,
    policy,
    activity,
    org,
    orgs,
  } = data;
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

  async function onApprove(id: string) {
    const result = await approveRecommendation({ data: id }).catch(() => ({ ok: false }));
    if (result.ok) toast.success("Approved — enters the pipeline on the next tick");
    else toast.error("Approve failed — are you an owner, and is the API up?");
    await router.invalidate();
  }

  async function onUnhide(id: string) {
    const result = await unhideRecommendation({ data: id }).catch(() => ({ ok: false }));
    if (result.ok) toast.success("Index un-hidden — this drop won't be proposed again for 90 days");
    else toast.error("Could not un-hide — the cluster may be unreachable or read-only");
    await router.invalidate();
  }

  async function onUndo(id: string) {
    const result = await rollbackRecommendation({ data: id }).catch(() => ({ ok: false }));
    if (result.ok) toast.success("Undo complete — the index was rebuilt");
    else toast.error("Undo failed — the cluster may be unreachable or read-only");
    await router.invalidate();
  }

  async function onSignOut() {
    await signOut();
    await router.invalidate();
  }

  async function onSwitchOrg(orgId: string) {
    const result = await switchOrgFn({ data: orgId }).catch(() => ({ ok: false, name: null }));
    if (result.ok) toast.success(`Switched to ${result.name ?? "org"}`);
    else toast.error("Org switch failed");
    // The selected cluster belongs to the previous org — reset the selection.
    await navigate({ to: "/app", search: {} });
    await router.invalidate();
  }

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
    <main className="mx-auto max-w-4xl p-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-semibold text-2xl">Indexterity</h1>
          {cluster === null ? (
            <p className="mt-1 text-muted-foreground">No cluster connected</p>
          ) : (
            <ClusterBar
              cluster={cluster}
              clusters={clusters}
              onChanged={() => router.invalidate()}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {orgs.length > 1 ? (
            <Select
              value={orgs.find((entry) => entry.active)?.orgId ?? ""}
              onValueChange={(value) => void onSwitchOrg(value)}
            >
              <SelectTrigger size="sm" className="w-[220px]" aria-label="Switch organization">
                <SelectValue placeholder="Organization" />
              </SelectTrigger>
              <SelectContent>
                {orgs.map((entry) => (
                  <SelectItem key={entry.orgId} value={entry.orgId}>
                    {entry.name} ({entry.role})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void onSignOut()}>
            Sign out
          </Button>
        </div>
      </div>

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
                    onConfirm={() => void onApprove(rec.id)}
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
                    onConfirm={() => void onUndo(rec.id)}
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
                    onConfirm={() => void onUnhide(rec.id)}
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
        <PolicySection key={policy.clusterId} policy={policy} onSaved={() => router.invalidate()} />
      ) : null}
      <ConnectClusterForm />
      <TeamSection org={org} onChanged={() => router.invalidate()} />
    </main>
  );
}
