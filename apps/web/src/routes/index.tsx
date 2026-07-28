import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge } from "../components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { serverApi } from "../lib/api";
import { signIn, signOut, signUp } from "../lib/auth";

// Runs on the web server for every navigation; forwards the session cookie to the
// api. A 401 means "not signed in" — the component shows the auth form instead.
const loadDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const api = serverApi();
  const clustersResult = await api.listClusters();
  if (clustersResult.status === 401) return { authed: false as const };
  const clusters = clustersResult.status === 200 ? clustersResult.body : [];
  const cluster = clusters[0] ?? null;
  if (cluster === null) {
    return {
      authed: true as const,
      cluster,
      recommendations: [],
      roi: { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0 },
      latency: { collections: [] },
    };
  }
  const [recResult, roiResult, latencyResult] = await Promise.all([
    api.listRecommendations({ params: { clusterId: cluster.id } }),
    api.getRoi({ params: { clusterId: cluster.id } }),
    api.getLatency({ params: { clusterId: cluster.id } }),
  ]);
  return {
    authed: true as const,
    cluster,
    recommendations: recResult.status === 200 ? recResult.body : [],
    roi:
      roiResult.status === 200
        ? roiResult.body
        : { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0 },
    latency: latencyResult.status === 200 ? latencyResult.body : { collections: [] },
  };
});

const approveRecommendation = createServerFn({ method: "POST" })
  .validator((id: unknown): string => {
    if (typeof id !== "string") throw new Error("id must be a string");
    return id;
  })
  .handler(async ({ data }) => {
    const result = await serverApi().approveRecommendation({ params: { id: data }, body: {} });
    return { ok: result.status === 200 };
  });

const rollbackRecommendation = createServerFn({ method: "POST" })
  .validator((id: unknown): string => {
    if (typeof id !== "string") throw new Error("id must be a string");
    return id;
  })
  .handler(async ({ data }) => {
    const result = await serverApi().rollbackRecommendation({ params: { id: data }, body: {} });
    return { ok: result.status === 200 };
  });

export const Route = createFileRoute("/")({
  loader: () => loadDashboard(),
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
  const data = Route.useLoaderData();
  const router = useRouter();

  if (!data.authed) return <AuthForm onDone={() => router.invalidate()} />;

  const { cluster, recommendations, roi, latency } = data;
  const proposed = recommendations.filter((rec) => rec.state === "PROPOSED");
  const totalSaved = proposed.reduce((sum, rec) => sum + rec.estimatedBytesSaved, 0);

  async function onApprove(id: string) {
    await approveRecommendation({ data: id });
    await router.invalidate();
  }

  async function onUndo(id: string) {
    await rollbackRecommendation({ data: id });
    await router.invalidate();
  }

  async function onSignOut() {
    await signOut();
    await router.invalidate();
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-semibold text-2xl">mongo-optimizer</h1>
          <p className="mt-1 text-muted-foreground">
            {cluster ? cluster.name : "No cluster connected"}
            {cluster?.demoMode ? " · demo (read-only)" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onSignOut()}
          className="rounded-md border px-2 py-1 text-muted-foreground text-xs"
        >
          Sign out
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-lg border p-4">
          <div className="text-muted-foreground text-sm">Proposed reclaimable</div>
          <div className="font-semibold text-2xl">{(totalSaved / 1024).toFixed(0)} KB</div>
          <div className="text-muted-foreground text-sm">{proposed.length} recommendations</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-muted-foreground text-sm">Reclaimed</div>
          <div className="font-semibold text-2xl">{(roi.freedBytes / 1024).toFixed(0)} KB</div>
          <div className="text-muted-foreground text-sm">
            {roi.indexesDropped} indexes dropped · ${roi.estimatedMonthlyUsd.toFixed(2)}/mo
          </div>
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
                ) : rec.state === "DROPPED" ? (
                  <button
                    type="button"
                    onClick={() => {
                      void onUndo(rec.id);
                    }}
                    className="rounded-md border px-2 py-1 text-xs"
                  >
                    Undo
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

function AuthForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const result =
      mode === "in"
        ? await signIn({ data: { email, password } })
        : await signUp({ data: { email, password, name } });
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.error);
  }

  return (
    <main className="mx-auto mt-24 max-w-sm p-8">
      <h1 className="font-semibold text-2xl">mongo-optimizer</h1>
      <p className="mt-1 text-muted-foreground">
        {mode === "in" ? "Sign in to your account" : "Create an account"}
      </p>
      <form
        className="mt-6 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "up" ? (
          <input
            className="rounded-md border px-3 py-2 text-sm"
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        ) : null}
        <input
          className="rounded-md border px-3 py-2 text-sm"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          className="rounded-md border px-3 py-2 text-sm"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <p className="text-red-600 text-sm">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-primary px-3 py-2 text-primary-foreground text-sm disabled:opacity-50"
        >
          {mode === "in" ? "Sign in" : "Sign up"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setMode(mode === "in" ? "up" : "in")}
        className="mt-4 text-muted-foreground text-sm underline"
      >
        {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
    </main>
  );
}
