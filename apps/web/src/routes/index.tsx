import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Badge } from "../components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { api } from "../lib/api";

// Runs on the web server (not the browser) — calls the api with no CORS.
const approveRecommendation = createServerFn({ method: "POST" })
  .validator((id: unknown): string => {
    if (typeof id !== "string") throw new Error("id must be a string");
    return id;
  })
  .handler(async ({ data }) => {
    const result = await api.approveRecommendation({ params: { id: data }, body: {} });
    return { ok: result.status === 200 };
  });

export const Route = createFileRoute("/")({
  // Runs on the server for the initial render — no CORS, data ready in the HTML.
  loader: async () => {
    const clustersResult = await api.listClusters();
    const clusters = clustersResult.status === 200 ? clustersResult.body : [];
    const cluster = clusters[0] ?? null;
    if (cluster === null) {
      return {
        cluster,
        recommendations: [],
        roi: { freedBytes: 0, indexesDropped: 0 },
        latency: { collections: [] },
      };
    }
    const [recResult, roiResult, latencyResult] = await Promise.all([
      api.listRecommendations({ params: { clusterId: cluster.id } }),
      api.getRoi({ params: { clusterId: cluster.id } }),
      api.getLatency({ params: { clusterId: cluster.id } }),
    ]);
    return {
      cluster,
      recommendations: recResult.status === 200 ? recResult.body : [],
      roi: roiResult.status === 200 ? roiResult.body : { freedBytes: 0, indexesDropped: 0 },
      latency: latencyResult.status === 200 ? latencyResult.body : { collections: [] },
    };
  },
  component: Home,
});

function badgeVariant(type: string): "secondary" | "destructive" | "default" | "outline" {
  if (type === "DROP_REDUNDANT") return "secondary";
  if (type === "DROP_UNUSED") return "destructive";
  return "outline"; // CREATE / UPDATE / MERGE (additive)
}

function fmtMicros(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}`;
}

function DeltaCell({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground">—</span>;
  const tone = pct < 0 ? "text-green-600" : pct > 0 ? "text-red-600" : "text-muted-foreground";
  return (
    <span className={tone}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(0)}%
    </span>
  );
}

function Home() {
  const { cluster, recommendations, roi, latency } = Route.useLoaderData();
  const router = useRouter();
  const proposed = recommendations.filter((rec) => rec.state === "PROPOSED");
  const totalSaved = proposed.reduce((sum, rec) => sum + rec.estimatedBytesSaved, 0);

  async function onApprove(id: string) {
    await approveRecommendation({ data: id });
    await router.invalidate();
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="font-semibold text-2xl">mongo-optimizer</h1>
      <p className="mt-1 text-muted-foreground">
        {cluster ? cluster.name : "No cluster connected"}
        {cluster?.demoMode ? " · demo (read-only)" : ""}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-lg border p-4">
          <div className="text-muted-foreground text-sm">Proposed reclaimable</div>
          <div className="font-semibold text-2xl">{(totalSaved / 1024).toFixed(0)} KB</div>
          <div className="text-muted-foreground text-sm">{proposed.length} recommendations</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-muted-foreground text-sm">Reclaimed</div>
          <div className="font-semibold text-2xl">{(roi.freedBytes / 1024).toFixed(0)} KB</div>
          <div className="text-muted-foreground text-sm">{roi.indexesDropped} indexes dropped</div>
        </div>
      </div>

      <Table className="mt-6">
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Collection</TableHead>
            <TableHead>Index</TableHead>
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
              <TableCell>{rec.usageClass ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{rec.rationale}</TableCell>
              <TableCell>
                {rec.state === "PROPOSED" ? (
                  <button
                    type="button"
                    onClick={() => {
                      void onApprove(rec.id);
                    }}
                    className="rounded-md bg-primary px-2 py-1 text-primary-foreground text-xs"
                  >
                    Approve
                  </button>
                ) : (
                  <span className="text-muted-foreground text-xs">{rec.state}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {latency.collections.length > 0 ? (
        <>
          <h2 className="mt-8 font-semibold text-lg">Latency — µs per op</h2>
          <p className="text-muted-foreground text-sm">
            Current windowed average vs the first sample; negative Δ = faster.
          </p>
          <Table className="mt-2">
            <TableHeader>
              <TableRow>
                <TableHead>Collection</TableHead>
                <TableHead>Read µs</TableHead>
                <TableHead>Read Δ</TableHead>
                <TableHead>Write µs</TableHead>
                <TableHead>Write Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latency.collections.map((coll) => (
                <TableRow key={`${coll.database}.${coll.collection}`}>
                  <TableCell className="font-mono text-xs">
                    {coll.database}.{coll.collection}
                  </TableCell>
                  <TableCell>{fmtMicros(coll.currentReadMicros)}</TableCell>
                  <TableCell>
                    <DeltaCell pct={coll.readDeltaPct} />
                  </TableCell>
                  <TableCell>{fmtMicros(coll.currentWriteMicros)}</TableCell>
                  <TableCell>
                    <DeltaCell pct={coll.writeDeltaPct} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : null}
    </main>
  );
}
