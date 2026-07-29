import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { LineChart, SERIES_PALETTE } from "../components/latency-chart";
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
const EMPTY_ORG = { id: "", name: "", members: [], pendingInvites: [] };

const loadDashboard = createServerFn({ method: "GET" })
  .validator((selected: unknown): string | null => (typeof selected === "string" ? selected : null))
  .handler(async ({ data: selected }) => {
    const api = serverApi();
    let clustersResult: Awaited<ReturnType<typeof api.listClusters>>;
    let orgResult: Awaited<ReturnType<typeof api.getOrg>>;
    try {
      [clustersResult, orgResult] = await Promise.all([api.listClusters(), api.getOrg()]);
    } catch {
      // The api is unreachable — render a friendly state instead of a 500.
      return { authed: false as const, apiDown: true as const };
    }
    if (clustersResult.status === 401) return { authed: false as const, apiDown: false as const };
    const org = orgResult.status === 200 ? orgResult.body : EMPTY_ORG;
    const clusters = clustersResult.status === 200 ? clustersResult.body : [];
    const cluster = clusters.find((c) => c.id === selected) ?? clusters[0] ?? null;
    if (cluster === null) {
      return {
        authed: true as const,
        clusters,
        cluster,
        recommendations: [],
        roi: { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0 },
        latency: { collections: [] },
        latencySeries: { collections: [] },
        policy: null,
        activity: [],
        org,
      };
    }
    const [recResult, roiResult, latencyResult, seriesResult, policyResult, actionsResult] =
      await Promise.all([
        api.listRecommendations({ params: { clusterId: cluster.id } }),
        api.getRoi({ params: { clusterId: cluster.id } }),
        api.getLatency({ params: { clusterId: cluster.id } }),
        api.getLatencySeries({ params: { clusterId: cluster.id } }),
        api.getPolicy({ params: { clusterId: cluster.id } }),
        api.listActions({ params: { clusterId: cluster.id } }),
      ]);
    return {
      authed: true as const,
      clusters,
      cluster,
      recommendations: recResult.status === 200 ? recResult.body : [],
      roi:
        roiResult.status === 200
          ? roiResult.body
          : { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0 },
      latency: latencyResult.status === 200 ? latencyResult.body : { collections: [] },
      latencySeries: seriesResult.status === 200 ? seriesResult.body : { collections: [] },
      policy: policyResult.status === 200 ? policyResult.body : null,
      activity: actionsResult.status === 200 ? actionsResult.body : [],
      org,
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

const createInvite = createServerFn({ method: "POST" })
  .validator((email: unknown): string => {
    if (typeof email !== "string" || email.length === 0) throw new Error("email required");
    return email;
  })
  .handler(async ({ data }) => {
    const result = await serverApi().createInvite({ body: { email: data, role: "member" } });
    if (result.status !== 200) return { token: null };
    return { token: result.body.token };
  });

const acceptInvite = createServerFn({ method: "POST" })
  .validator((token: unknown): string => {
    if (typeof token !== "string" || token.length === 0) throw new Error("token required");
    return token;
  })
  .handler(async ({ data }) => {
    const result = await serverApi().acceptInvite({ body: { token: data } });
    if (result.status === 200) return { ok: true, message: `joined ${result.body.orgName}` };
    const message = result.status === 404 || result.status === 409 ? result.body.message : "failed";
    return { ok: false, message };
  });

const connectCluster = createServerFn({ method: "POST" })
  .validator((data: unknown): { name: string; connectionString: string } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "name" in data &&
      "connectionString" in data &&
      typeof data.name === "string" &&
      typeof data.connectionString === "string"
    ) {
      return { name: data.name, connectionString: data.connectionString };
    }
    throw new Error("invalid cluster");
  })
  .handler(async ({ data }) => {
    const result = await serverApi().createCluster({ body: data });
    if (result.status === 200) return { ok: true, message: null, id: result.body.id };
    const message = result.status === 400 ? result.body.message : "failed to connect cluster";
    return { ok: false, message, id: null };
  });

interface PolicyInput {
  readonly clusterId: string;
  readonly autoApply: boolean;
  readonly workloadAnalysis: boolean;
  readonly instantCreate: boolean;
  readonly observeWindowDays: number;
}

const savePolicy = createServerFn({ method: "POST" })
  .validator((data: unknown): PolicyInput => {
    if (
      typeof data === "object" &&
      data !== null &&
      "clusterId" in data &&
      typeof data.clusterId === "string" &&
      "autoApply" in data &&
      typeof data.autoApply === "boolean" &&
      "workloadAnalysis" in data &&
      typeof data.workloadAnalysis === "boolean" &&
      "instantCreate" in data &&
      typeof data.instantCreate === "boolean" &&
      "observeWindowDays" in data &&
      typeof data.observeWindowDays === "number"
    ) {
      return {
        clusterId: data.clusterId,
        autoApply: data.autoApply,
        workloadAnalysis: data.workloadAnalysis,
        instantCreate: data.instantCreate,
        observeWindowDays: data.observeWindowDays,
      };
    }
    throw new Error("invalid policy");
  })
  .handler(async ({ data }) => {
    const result = await serverApi().updatePolicy({
      params: { clusterId: data.clusterId },
      body: {
        autoApply: data.autoApply,
        workloadAnalysis: data.workloadAnalysis,
        instantCreate: data.instantCreate,
        observeWindowDays: data.observeWindowDays,
        maxCollectionSizeBytes: null,
      },
    });
    return { ok: result.status === 200 };
  });

const setClusterMode = createServerFn({ method: "POST" })
  .validator((data: unknown): { clusterId: string; readOnly: boolean } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "clusterId" in data &&
      "readOnly" in data &&
      typeof data.clusterId === "string" &&
      typeof data.readOnly === "boolean"
    ) {
      return { clusterId: data.clusterId, readOnly: data.readOnly };
    }
    throw new Error("invalid mode change");
  })
  .handler(async ({ data }) => {
    const result = await serverApi().setClusterMode({
      params: { clusterId: data.clusterId },
      body: { readOnly: data.readOnly },
    });
    return { ok: result.status === 200 };
  });

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { cluster?: string } =>
    typeof search.cluster === "string" ? { cluster: search.cluster } : {},
  loaderDeps: ({ search }) => ({ cluster: search.cluster ?? null }),
  loader: ({ deps }) => loadDashboard({ data: deps.cluster }),
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

  if (!data.authed) {
    if (data.apiDown) {
      return (
        <main className="mx-auto mt-24 max-w-sm p-8">
          <h1 className="font-semibold text-2xl">Indexterity</h1>
          <p className="mt-2 text-muted-foreground">
            The API is unreachable right now. Retry in a moment.
          </p>
          <button
            type="button"
            onClick={() => void router.invalidate()}
            className="mt-4 rounded-md border px-3 py-1.5 text-sm"
          >
            Retry
          </button>
        </main>
      );
    }
    return <AuthForm onDone={() => router.invalidate()} />;
  }

  const { cluster, clusters, recommendations, roi, latency, latencySeries, policy, activity, org } =
    data;
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
                    {new Date(entry.createdAt).toLocaleString()}
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

interface ClusterOption {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
}

function ClusterBar({
  cluster,
  clusters,
  onChanged,
}: {
  cluster: ClusterOption;
  clusters: readonly ClusterOption[];
  onChanged: () => void;
}) {
  const navigate = useNavigate();

  async function onToggleMode() {
    const goingLive = cluster.readOnly;
    if (
      goingLive &&
      !window.confirm(
        "Enable live mode? The engine will be allowed to modify indexes on this cluster (hide, drop, build).",
      )
    ) {
      return;
    }
    await setClusterMode({ data: { clusterId: cluster.id, readOnly: !cluster.readOnly } });
    onChanged();
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      {clusters.length > 1 ? (
        <select
          className="rounded-md border px-2 py-1 text-sm"
          value={cluster.id}
          onChange={(event) => {
            void navigate({ to: "/", search: { cluster: event.target.value } });
          }}
        >
          {clusters.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-muted-foreground">{cluster.name}</span>
      )}
      <span className={cluster.readOnly ? "text-muted-foreground text-xs" : "text-red-600 text-xs"}>
        {cluster.readOnly ? "read-only" : "live"}
      </span>
      <button
        type="button"
        onClick={() => void onToggleMode()}
        className="rounded-md border px-2 py-0.5 text-muted-foreground text-xs"
      >
        {cluster.readOnly ? "Go live" : "Make read-only"}
      </button>
    </div>
  );
}

interface PolicyView {
  readonly clusterId: string;
  readonly autoApply: boolean;
  readonly workloadAnalysis: boolean;
  readonly instantCreate: boolean;
  readonly observeWindowDays: number;
}

// The engine knobs, owner-editable. Checkbox changes stage locally; Save PUTs.
function PolicySection({ policy, onSaved }: { policy: PolicyView; onSaved: () => void }) {
  const [autoApply, setAutoApply] = useState(policy.autoApply);
  const [workloadAnalysis, setWorkloadAnalysis] = useState(policy.workloadAnalysis);
  const [instantCreate, setInstantCreate] = useState(policy.instantCreate);
  const [observeDays, setObserveDays] = useState(policy.observeWindowDays);
  const [saved, setSaved] = useState<boolean | null>(null);

  async function onSave() {
    const result = await savePolicy({
      data: {
        clusterId: policy.clusterId,
        autoApply,
        workloadAnalysis,
        instantCreate,
        observeWindowDays: observeDays,
      },
    });
    setSaved(result.ok);
    if (result.ok) onSaved();
  }

  const toggles: Array<{ label: string; hint: string; value: boolean; set: (v: boolean) => void }> =
    [
      {
        label: "Auto-apply",
        hint: "approve recommendations without a human",
        value: autoApply,
        set: setAutoApply,
      },
      {
        label: "Workload analysis",
        hint: "propose CREATE/UPDATE/MERGE from query shapes",
        value: workloadAnalysis,
        set: setWorkloadAnalysis,
      },
      {
        label: "Instant create",
        hint: "auto-build critical missing indexes",
        value: instantCreate,
        set: setInstantCreate,
      },
    ];

  return (
    <section className="mt-8">
      <h2 className="font-semibold text-lg">Policy</h2>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        {toggles.map((toggle) => (
          <label
            key={toggle.label}
            className="flex items-center gap-1.5 text-sm"
            title={toggle.hint}
          >
            <input
              type="checkbox"
              checked={toggle.value}
              onChange={(event) => toggle.set(event.target.checked)}
            />
            {toggle.label}
          </label>
        ))}
        <label className="flex items-center gap-1.5 text-sm">
          Observe window
          <input
            type="number"
            min={1}
            max={365}
            value={observeDays}
            onChange={(event) => setObserveDays(Number(event.target.value))}
            className="w-16 rounded-md border px-2 py-1 text-sm"
          />
          days
        </label>
        <button
          type="button"
          onClick={() => void onSave()}
          className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm"
        >
          Save
        </button>
        {saved === false ? (
          <span className="text-red-600 text-sm">not saved (owner only)</span>
        ) : null}
        {saved === true ? <span className="text-muted-foreground text-sm">saved</span> : null}
      </div>
    </section>
  );
}

function ConnectClusterForm() {
  const router = useRouter();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [connString, setConnString] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await connectCluster({ data: { name, connectionString: connString } });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName("");
    setConnString("");
    if (result.id !== null) await navigate({ to: "/", search: { cluster: result.id } });
    await router.invalidate();
  }

  return (
    <section className="mt-8">
      <h2 className="font-semibold text-lg">Connect a cluster</h2>
      <p className="text-muted-foreground text-sm">
        Starts in read-only mode — the engine analyzes but never writes until you go live.
      </p>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="rounded-md border px-3 py-1.5 text-sm"
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="min-w-72 flex-1 rounded-md border px-3 py-1.5 font-mono text-sm"
          placeholder="mongodb://user:pass@host:27017"
          value={connString}
          onChange={(event) => setConnString(event.target.value)}
        />
        <button
          type="submit"
          disabled={busy || name.length === 0 || connString.length === 0}
          className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm disabled:opacity-50"
        >
          Connect
        </button>
      </form>
      {error !== null ? <p className="mt-2 text-red-600 text-sm">{error}</p> : null}
    </section>
  );
}

interface TeamOrg {
  readonly name: string;
  readonly members: readonly { userId: string; email: string; name: string; role: string }[];
  readonly pendingInvites: readonly { email: string; role: string; expiresAt: string }[];
}

function TeamSection({ org, onChanged }: { org: TeamOrg; onChanged: () => void }) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [acceptToken, setAcceptToken] = useState("");
  const [acceptMessage, setAcceptMessage] = useState<string | null>(null);

  async function onInvite() {
    const result = await createInvite({ data: inviteEmail });
    setInviteToken(result.token);
    setInviteEmail("");
    onChanged();
  }

  async function onAccept() {
    const result = await acceptInvite({ data: acceptToken });
    setAcceptMessage(result.message);
    setAcceptToken("");
    if (result.ok) onChanged();
  }

  return (
    <section className="mt-8">
      <h2 className="font-semibold text-lg">Team — {org.name}</h2>
      <ul className="mt-2 space-y-1">
        {org.members.map((member) => (
          <li key={member.userId} className="text-sm">
            {member.name} <span className="text-muted-foreground">({member.email})</span> ·{" "}
            <span className="text-muted-foreground">{member.role}</span>
          </li>
        ))}
        {org.pendingInvites.map((invite) => (
          <li key={invite.email} className="text-muted-foreground text-sm">
            {invite.email} · invited ({invite.role})
          </li>
        ))}
      </ul>

      <div className="mt-4 flex gap-2">
        <input
          className="rounded-md border px-3 py-1.5 text-sm"
          type="email"
          placeholder="teammate@company.com"
          value={inviteEmail}
          onChange={(event) => setInviteEmail(event.target.value)}
        />
        <button
          type="button"
          onClick={() => void onInvite()}
          className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm"
        >
          Invite
        </button>
      </div>
      {inviteToken !== null ? (
        <p className="mt-2 text-sm">
          Share this token: <code className="rounded bg-muted px-1 font-mono">{inviteToken}</code>
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <input
          className="rounded-md border px-3 py-1.5 font-mono text-sm"
          placeholder="Paste an invite token"
          value={acceptToken}
          onChange={(event) => setAcceptToken(event.target.value)}
        />
        <button
          type="button"
          onClick={() => void onAccept()}
          className="rounded-md border px-3 py-1.5 text-sm"
        >
          Join org
        </button>
      </div>
      {acceptMessage !== null ? (
        <p className="mt-2 text-muted-foreground text-sm">{acceptMessage}</p>
      ) : null}
    </section>
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
      <h1 className="font-semibold text-2xl">Indexterity</h1>
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
