import { ORPCError } from "@orpc/client";
import type { ConnectionDiagnosis, PrivilegeCheck } from "@repo/contracts";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "~/components/confirm-button";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { formatTimestamp, useMounted } from "~/lib/hydration";
import { LineChart, SERIES_PALETTE } from "../components/latency-chart";
import { serverApi } from "../lib/api";
import { requestPasswordReset, signIn, signOut, signUp } from "../lib/auth";
import { REQUEST_ACCESS_HREF } from "../lib/site";

// Runs on the web server for every navigation; forwards the session cookie to
// the api. oRPC calls return data directly and throw ORPCError on failure.
const EMPTY_ORG = { id: "", name: "", members: [], pendingInvites: [] };

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ORPCError && error.status === status;
}

const loadDashboard = createServerFn({ method: "GET" })
  .validator((selected: unknown): string | null => (typeof selected === "string" ? selected : null))
  .handler(async ({ data: selected }) => {
    const api = serverApi();
    let clusters: Awaited<ReturnType<typeof api.listClusters>>;
    let org: Awaited<ReturnType<typeof api.getOrg>>;
    let orgs: Awaited<ReturnType<typeof api.listOrgs>>;
    try {
      [clusters, org, orgs] = await Promise.all([api.listClusters(), api.getOrg(), api.listOrgs()]);
    } catch (error) {
      if (isStatus(error, 401)) return { authed: false as const, apiDown: false as const };
      // The api is unreachable — render a friendly state instead of a 500.
      return { authed: false as const, apiDown: true as const };
    }
    const cluster = clusters.find((c) => c.id === selected) ?? clusters[0] ?? null;
    if (cluster === null) {
      return {
        authed: true as const,
        clusters,
        cluster,
        recommendations: [],
        roi: { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0, attribution: [] },
        latency: { collections: [] },
        latencySeries: { collections: [] },
        collectionStats: { collections: [] },
        policy: null,
        activity: [],
        org: org ?? EMPTY_ORG,
        orgs,
      };
    }
    try {
      const [recommendations, roi, latency, latencySeries, collectionStats, policy, activity] =
        await Promise.all([
          api.listRecommendations({ clusterId: cluster.id }),
          api.getRoi({ clusterId: cluster.id }),
          api.getLatency({ clusterId: cluster.id }),
          api.getLatencySeries({ clusterId: cluster.id }),
          api.getCollections({ clusterId: cluster.id }),
          api.getPolicy({ clusterId: cluster.id }),
          api.listActions({ clusterId: cluster.id }),
        ]);
      return {
        authed: true as const,
        clusters,
        cluster,
        recommendations,
        roi,
        latency,
        latencySeries,
        collectionStats,
        policy,
        activity,
        org,
        orgs,
      };
    } catch (error) {
      if (isStatus(error, 401)) return { authed: false as const, apiDown: false as const };
      // The api died between the two batches — same friendly state, no 500.
      return { authed: false as const, apiDown: true as const };
    }
  });

const approveRecommendation = createServerFn({ method: "POST" })
  .validator((id: unknown): string => {
    if (typeof id !== "string") throw new Error("id must be a string");
    return id;
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().approveRecommendation({ id: data });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

const rollbackRecommendation = createServerFn({ method: "POST" })
  .validator((id: unknown): string => {
    if (typeof id !== "string") throw new Error("id must be a string");
    return id;
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().rollbackRecommendation({ id: data });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

const createInvite = createServerFn({ method: "POST" })
  .validator((email: unknown): string => {
    if (typeof email !== "string" || email.length === 0) throw new Error("email required");
    return email;
  })
  .handler(async ({ data }) => {
    try {
      const invite = await serverApi().createInvite({ email: data, role: "member" });
      return { token: invite.token };
    } catch {
      return { token: null };
    }
  });

const acceptInvite = createServerFn({ method: "POST" })
  .validator((token: unknown): string => {
    if (typeof token !== "string" || token.length === 0) throw new Error("token required");
    return token;
  })
  .handler(async ({ data }) => {
    try {
      const joined = await serverApi().acceptInvite({ token: data });
      return { ok: true, message: `joined ${joined.orgName}` };
    } catch (error) {
      const message = error instanceof ORPCError ? error.message : "failed";
      return { ok: false, message };
    }
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
    try {
      const created = await serverApi().createCluster(data);
      return { ok: true, message: null, id: created.id };
    } catch (error) {
      const message =
        error instanceof ORPCError && error.status === 400
          ? error.message
          : "failed to connect cluster";
      return { ok: false, message, id: null };
    }
  });

function orpcMessage(error: unknown, fallback: string): string {
  return error instanceof ORPCError && [400, 403, 404, 409].includes(error.status)
    ? error.message
    : fallback;
}

const renameOrg = createServerFn({ method: "POST" })
  .validator((name: unknown): string => {
    if (typeof name !== "string" || name.length === 0) throw new Error("name required");
    return name;
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().renameOrg({ name: data });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

const setMemberRole = createServerFn({ method: "POST" })
  .validator((data: unknown): { userId: string; role: "member" | "owner" } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "userId" in data &&
      "role" in data &&
      typeof data.userId === "string" &&
      (data.role === "member" || data.role === "owner")
    ) {
      return { userId: data.userId, role: data.role };
    }
    throw new Error("invalid role change");
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().setMemberRole(data);
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: orpcMessage(error, "role change failed") };
    }
  });

const removeMember = createServerFn({ method: "POST" })
  .validator((userId: unknown): string => {
    if (typeof userId !== "string" || userId.length === 0) throw new Error("userId required");
    return userId;
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().removeMember({ userId: data });
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: orpcMessage(error, "remove failed") };
    }
  });

const leaveOrg = createServerFn({ method: "POST" })
  .validator((data: unknown): Record<string, never> => {
    if (typeof data === "object" && data !== null) return {};
    throw new Error("invalid");
  })
  .handler(async () => {
    try {
      await serverApi().leaveOrg({});
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: orpcMessage(error, "leave failed") };
    }
  });

// Credential rotation: verified server-side before storing, so a typo can't
// brick the cluster; history survives (unlike disconnect + reconnect).
const rotateConnection = createServerFn({ method: "POST" })
  .validator((data: unknown): { clusterId: string; connectionString: string } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "clusterId" in data &&
      "connectionString" in data &&
      typeof data.clusterId === "string" &&
      typeof data.connectionString === "string"
    ) {
      return { clusterId: data.clusterId, connectionString: data.connectionString };
    }
    throw new Error("invalid rotation");
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().rotateConnection(data);
      return { ok: true, message: null };
    } catch (error) {
      const message =
        error instanceof ORPCError && [400, 404, 502].includes(error.status)
          ? error.message
          : "rotation failed";
      return { ok: false, message };
    }
  });

// Onboarding preflight: nothing is stored, nothing is written on the cluster.
const checkConnection = createServerFn({ method: "POST" })
  .validator((connectionString: unknown): string => {
    if (typeof connectionString !== "string" || connectionString.length === 0) {
      throw new Error("connection string required");
    }
    return connectionString;
  })
  .handler(async ({ data }) => {
    try {
      return {
        ok: true as const,
        diagnosis: await serverApi().checkConnection({
          connectionString: data,
        }),
      };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof ORPCError ? error.message : "could not check the connection",
      };
    }
  });

interface ProvisionResult {
  readonly ok: boolean;
  readonly message: string | null;
  readonly id: string | null;
  readonly username: string | null;
  readonly connectionString: string | null;
}

// Admin-string onboarding: the api uses the admin string once to create a
// scoped user and returns that user's string (shown a single time).
const provisionCluster = createServerFn({ method: "POST" })
  .validator((data: unknown): { name: string; adminConnectionString: string } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "name" in data &&
      "adminConnectionString" in data &&
      typeof data.name === "string" &&
      typeof data.adminConnectionString === "string"
    ) {
      return { name: data.name, adminConnectionString: data.adminConnectionString };
    }
    throw new Error("invalid cluster");
  })
  .handler(async ({ data }): Promise<ProvisionResult> => {
    try {
      const created = await serverApi().provisionCluster(data);
      return {
        ok: true,
        message: null,
        id: created.cluster.id,
        username: created.username,
        connectionString: created.connectionString,
      };
    } catch (error) {
      // 400 bad string, 422 provision denied, 502 unreachable all carry guidance.
      const message =
        error instanceof ORPCError && [400, 422, 502].includes(error.status)
          ? error.message
          : "failed to provision the cluster";
      return { ok: false, message, id: null, username: null, connectionString: null };
    }
  });

const switchOrgFn = createServerFn({ method: "POST" })
  .validator((orgId: unknown): string => {
    if (typeof orgId !== "string" || orgId.length === 0) throw new Error("orgId required");
    return orgId;
  })
  .handler(async ({ data }) => {
    try {
      const switched = await serverApi().switchOrg({ orgId: data });
      return { ok: true, name: switched.name };
    } catch {
      return { ok: false, name: null };
    }
  });

// Offboard a cluster: the api restores in-flight hidden indexes, deletes all
// collected data, and reports how to revoke the provisioned user.
const disconnectCluster = createServerFn({ method: "POST" })
  .validator((clusterId: unknown): string => {
    if (typeof clusterId !== "string" || clusterId.length === 0) {
      throw new Error("clusterId required");
    }
    return clusterId;
  })
  .handler(async ({ data }) => {
    try {
      const result = await serverApi().deleteCluster({ clusterId: data });
      return {
        ok: true,
        unhidden: result.unhidden,
        revokeCommand: result.revokeCommand,
      };
    } catch {
      return { ok: false, unhidden: 0, revokeCommand: null };
    }
  });

interface PolicyInput {
  readonly clusterId: string;
  readonly autoApply: boolean;
  readonly workloadAnalysis: boolean;
  readonly instantCreate: boolean;
  readonly observeWindowDays: number;
  readonly autoApplyScore: number | null;
  readonly changeWindowStartHour: number | null;
  readonly changeWindowEndHour: number | null;
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
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
      typeof data.observeWindowDays === "number" &&
      "autoApplyScore" in data &&
      nullableNumber(data.autoApplyScore) &&
      "changeWindowStartHour" in data &&
      nullableNumber(data.changeWindowStartHour) &&
      "changeWindowEndHour" in data &&
      nullableNumber(data.changeWindowEndHour)
    ) {
      return {
        clusterId: data.clusterId,
        autoApply: data.autoApply,
        workloadAnalysis: data.workloadAnalysis,
        instantCreate: data.instantCreate,
        observeWindowDays: data.observeWindowDays,
        autoApplyScore: data.autoApplyScore,
        changeWindowStartHour: data.changeWindowStartHour,
        changeWindowEndHour: data.changeWindowEndHour,
      };
    }
    throw new Error("invalid policy");
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().updatePolicy({
        clusterId: data.clusterId,
        autoApply: data.autoApply,
        workloadAnalysis: data.workloadAnalysis,
        instantCreate: data.instantCreate,
        observeWindowDays: data.observeWindowDays,
        maxCollectionSizeBytes: null,
        autoApplyScore: data.autoApplyScore,
        changeWindowStartHour: data.changeWindowStartHour,
        changeWindowEndHour: data.changeWindowEndHour,
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
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
    try {
      await serverApi().setClusterMode({ clusterId: data.clusterId, readOnly: data.readOnly });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

export const Route = createFileRoute("/app")({
  validateSearch: (search: Record<string, unknown>): { cluster?: string } =>
    typeof search.cluster === "string" ? { cluster: search.cluster } : {},
  loaderDeps: ({ search }) => ({ cluster: search.cluster ?? null }),
  loader: ({ deps }) => loadDashboard({ data: deps.cluster }),
  // Inherits the root's noindex — the dashboard is behind auth.
  head: () => ({ meta: [{ title: "Dashboard — Indexterity" }] }),
  component: Home,
});

function badgeVariant(type: string): "secondary" | "destructive" | "default" | "outline" {
  if (type === "DROP_REDUNDANT" || type === "ADVISORY_REVIEW") return "secondary";
  if (type === "DROP_UNUSED") return "destructive";
  return "outline"; // CREATE / UPDATE / MERGE (additive)
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
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
              <TableCell className="text-xs">{rec.score}</TableCell>
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

interface ClusterOption {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly provisionedUsername: string | null;
  readonly lastCollectedAt: string | null;
}

// Anything older than this means the numbers on screen predate a gap in
// collection — say so rather than letting them read as current.
const STALE_AFTER_HOURS = 48;

function staleness(lastCollectedAt: string | null): string | null {
  if (lastCollectedAt === null) return "never collected";
  const hours = (Date.now() - new Date(lastCollectedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours < STALE_AFTER_HOURS) return null;
  const days = Math.floor(hours / 24);
  return days >= 1
    ? `last collected ${days} day${days === 1 ? "" : "s"} ago`
    : `last collected ${Math.floor(hours)}h ago`;
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
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateString, setRotateString] = useState("");
  // "How long since we last collected" depends on the reader's clock, so it
  // resolves after hydration rather than differing between the two renders.
  const stale = useMounted() ? staleness(cluster.lastCollectedAt) : null;

  async function onToggleMode() {
    const goingLive = cluster.readOnly;
    const result = await setClusterMode({
      data: { clusterId: cluster.id, readOnly: !cluster.readOnly },
    }).catch(() => ({ ok: false }));
    if (result.ok)
      toast.success(
        goingLive ? "Live mode enabled — the engine may now write" : "Cluster is read-only again",
      );
    else toast.error("Mode change failed (owner only)");
    onChanged();
  }

  async function onRotate() {
    const result = await rotateConnection({
      data: { clusterId: cluster.id, connectionString: rotateString },
    }).catch(() => ({ ok: false, message: "rotation failed" }));
    if (result.ok) {
      toast.success("Connection string rotated — history preserved");
      setRotateOpen(false);
      setRotateString("");
    } else {
      toast.error(result.message ?? "rotation failed");
    }
    onChanged();
  }

  async function onDisconnect() {
    const result = await disconnectCluster({ data: cluster.id }).catch(() => ({
      ok: false,
      unhidden: 0,
      revokeCommand: null,
    }));
    if (result.ok) {
      toast.success(
        result.unhidden > 0
          ? `Disconnected — ${result.unhidden} hidden ${result.unhidden === 1 ? "index" : "indexes"} restored`
          : "Cluster disconnected",
      );
    } else {
      toast.error("Disconnect failed (owner only)");
    }
    await navigate({ to: "/app", search: {} });
    onChanged();
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {clusters.length > 1 ? (
        <Select
          value={cluster.id}
          onValueChange={(value) => {
            void navigate({ to: "/app", search: { cluster: value } });
          }}
        >
          <SelectTrigger size="sm" className="w-[220px]" aria-label="Select cluster">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {clusters.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-muted-foreground">{cluster.name}</span>
      )}
      <Badge variant={cluster.readOnly ? "secondary" : "destructive"}>
        {cluster.readOnly ? "read-only" : "live"}
      </Badge>
      {cluster.provisionedUsername !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="font-mono">
              {cluster.provisionedUsername}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Indexterity runs as its own least-privilege user here — it cannot read your documents
          </TooltipContent>
        </Tooltip>
      ) : null}
      {stale !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-amber-500 text-amber-700">
              ⚠ {stale}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            These figures predate a gap in collection. Usage-based drop recommendations are withheld
            until the history is continuous again.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {cluster.readOnly ? (
        <ConfirmButton
          trigger={
            <Button variant="outline" size="sm">
              Go live
            </Button>
          }
          title="Enable live mode?"
          description={`The engine will be allowed to modify indexes on "${cluster.name}" — hide, drop and build. Drops still pass the observe window and the regression gate first.`}
          confirmLabel="Go live"
          onConfirm={() => void onToggleMode()}
        />
      ) : (
        <Button variant="outline" size="sm" onClick={() => void onToggleMode()}>
          Make read-only
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => setRotateOpen(!rotateOpen)}>
        Rotate string
      </Button>
      <ConfirmButton
        destructive
        trigger={
          <Button variant="ghost" size="sm" className="text-destructive">
            Disconnect
          </Button>
        }
        title={`Disconnect "${cluster.name}"?`}
        description={
          <>
            <p>
              All collected snapshots, recommendations, ROI history and the audit trail are deleted.
              Indexes still hidden in an observe window are restored first.
            </p>
            {cluster.provisionedUsername === null ? null : (
              <p>
                The scoped user stays on your cluster — revoke it afterwards:
                <code className="mt-1 block break-all rounded bg-muted p-2 font-mono text-xs">
                  db.getSiblingDB("admin").dropUser("{cluster.provisionedUsername}")
                </code>
              </p>
            )}
          </>
        }
        confirmLabel="Disconnect"
        onConfirm={() => void onDisconnect()}
      />
      {rotateOpen ? (
        <form
          className="flex w-full gap-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            void onRotate();
          }}
        >
          <Input
            className="min-w-72 flex-1 font-mono text-xs"
            placeholder="new mongodb:// connection string (verified before stored)"
            value={rotateString}
            onChange={(event) => setRotateString(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={rotateString.length === 0}>
            Save
          </Button>
        </form>
      ) : null}
    </div>
  );
}

interface PolicyView {
  readonly clusterId: string;
  readonly autoApply: boolean;
  readonly workloadAnalysis: boolean;
  readonly instantCreate: boolean;
  readonly observeWindowDays: number;
  readonly autoApplyScore: number | null;
  readonly changeWindowStartHour: number | null;
  readonly changeWindowEndHour: number | null;
}

// The engine knobs, owner-editable. Checkbox changes stage locally; Save PUTs.
function PolicySection({ policy, onSaved }: { policy: PolicyView; onSaved: () => void }) {
  const [autoApply, setAutoApply] = useState(policy.autoApply);
  const [workloadAnalysis, setWorkloadAnalysis] = useState(policy.workloadAnalysis);
  const [instantCreate, setInstantCreate] = useState(policy.instantCreate);
  const [observeDays, setObserveDays] = useState(policy.observeWindowDays);
  const [autoScore, setAutoScore] = useState(policy.autoApplyScore);
  const [windowStart, setWindowStart] = useState(policy.changeWindowStartHour);
  const [windowEnd, setWindowEnd] = useState(policy.changeWindowEndHour);

  async function onSave() {
    const result = await savePolicy({
      data: {
        clusterId: policy.clusterId,
        autoApply,
        workloadAnalysis,
        instantCreate,
        observeWindowDays: observeDays,
        autoApplyScore: autoScore,
        // Half-set windows are meaningless — persist only a complete pair.
        changeWindowStartHour: windowEnd === null ? null : windowStart,
        changeWindowEndHour: windowStart === null ? null : windowEnd,
      },
    }).catch(() => ({ ok: false }));
    if (result.ok) {
      toast.success("Policy saved");
      onSaved();
    } else {
      toast.error("Policy not saved (owner only)");
    }
  }

  const toggles: Array<{
    id: string;
    label: string;
    hint: string;
    value: boolean;
    set: (v: boolean) => void;
  }> = [
    {
      id: "policy-auto-apply",
      label: "Auto-apply",
      hint: "approve recommendations without a human",
      value: autoApply,
      set: setAutoApply,
    },
    {
      id: "policy-workload",
      label: "Workload analysis",
      hint: "propose CREATE/UPDATE/MERGE from query shapes",
      value: workloadAnalysis,
      set: setWorkloadAnalysis,
    },
    {
      id: "policy-instant-create",
      label: "Instant create",
      hint: "auto-build critical missing indexes",
      value: instantCreate,
      set: setInstantCreate,
    },
  ];

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">Policy</CardTitle>
        <CardDescription>
          The engine knobs for this cluster. Owner-only; the safety gates apply regardless.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-6">
          {toggles.map((toggle) => (
            <div key={toggle.label} className="flex items-start gap-2">
              <Checkbox
                id={toggle.id}
                checked={toggle.value}
                onCheckedChange={(checked) => toggle.set(checked === true)}
              />
              <div className="grid gap-0.5 leading-none">
                <Label htmlFor={toggle.id}>{toggle.label}</Label>
                <p className="text-muted-foreground text-xs">{toggle.hint}</p>
              </div>
            </div>
          ))}
        </div>

        <Separator />

        <div className="flex flex-wrap items-end gap-6">
          <div className="grid gap-1.5">
            <Label htmlFor="observe-days">Observe window (days)</Label>
            <Input
              id="observe-days"
              type="number"
              min={1}
              max={365}
              className="w-24"
              value={observeDays}
              onChange={(event) => setObserveDays(Number(event.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="auto-score">Auto-approve score ≥</Label>
            <Input
              id="auto-score"
              type="number"
              min={0}
              max={100}
              placeholder="off"
              className="w-24"
              value={autoScore ?? ""}
              onChange={(event) =>
                setAutoScore(event.target.value === "" ? null : Number(event.target.value))
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="window-start">Change window (UTC hours)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="window-start"
                type="number"
                min={0}
                max={23}
                placeholder="–"
                className="w-20"
                value={windowStart ?? ""}
                onChange={(event) =>
                  setWindowStart(event.target.value === "" ? null : Number(event.target.value))
                }
              />
              <span className="text-muted-foreground">→</span>
              <Input
                aria-label="Change window end hour"
                type="number"
                min={0}
                max={23}
                placeholder="–"
                className="w-20"
                value={windowEnd ?? ""}
                onChange={(event) =>
                  setWindowEnd(event.target.value === "" ? null : Number(event.target.value))
                }
              />
            </div>
          </div>
          <Button onClick={() => void onSave()}>Save policy</Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Elective changes (hide, build, drop) run only inside the change window; safety rollbacks
          never wait. Leave it empty for anytime — a start after the end wraps midnight.
        </p>
      </CardContent>
    </Card>
  );
}

function PrivilegeList({ privileges }: { privileges: readonly PrivilegeCheck[] }) {
  return (
    <ul className="mt-2 space-y-0.5 text-xs">
      {privileges.map((privilege) => (
        <li key={privilege.key} className="flex gap-2">
          <span className={privilege.granted ? "text-primary" : "text-red-600"}>
            {privilege.granted ? "✓" : "✗"}
          </span>
          <span className={privilege.granted ? "" : "font-medium"}>
            {privilege.label}
            {privilege.granted ? null : (
              <span className="font-normal text-muted-foreground"> — {privilege.enables}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConnectClusterForm() {
  const router = useRouter();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [connString, setConnString] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState<ConnectionDiagnosis | null>(null);
  const [provisioned, setProvisioned] = useState<{
    username: string;
    connectionString: string;
  } | null>(null);

  // Preflight: ask the api what these credentials may do before storing them.
  async function onCheck() {
    setBusy(true);
    setError(null);
    setDiagnosis(null);
    setProvisioned(null);
    const result = await checkConnection({ data: connString }).catch(() => ({
      ok: false as const,
      message: "could not check the connection",
    }));
    setBusy(false);
    if (result.ok) setDiagnosis(result.diagnosis);
    else setError(result.message);
  }

  async function finish(result: { ok: boolean; message: string | null; id: string | null }) {
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setName("");
    setConnString("");
    setDiagnosis(null);
    if (result.id !== null) await navigate({ to: "/app", search: { cluster: result.id } });
    await router.invalidate();
  }

  async function onConnectAsIs() {
    setBusy(true);
    setError(null);
    const result = await connectCluster({ data: { name, connectionString: connString } });
    setBusy(false);
    await finish(result);
  }

  // Consent path: the admin string is used once to create the scoped user and
  // is never stored.
  async function onProvision() {
    setBusy(true);
    setError(null);
    const result = await provisionCluster({
      data: { name, adminConnectionString: connString },
    });
    setBusy(false);
    if (result.ok && result.username !== null && result.connectionString !== null) {
      setProvisioned({ username: result.username, connectionString: result.connectionString });
    }
    await finish(result);
  }

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">Connect a cluster</CardTitle>
        <CardDescription>
          Paste any connection string — Indexterity checks what it can do before storing anything.
          Clusters start in read-only mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onCheck();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="cluster-name">Name</Label>
            <Input
              id="cluster-name"
              className="w-48"
              placeholder="Production"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid min-w-72 flex-1 gap-1.5">
            <Label htmlFor="cluster-conn">Connection string</Label>
            <Input
              id="cluster-conn"
              className="font-mono"
              placeholder="mongodb://user:pass@host:27017"
              value={connString}
              onChange={(event) => {
                setConnString(event.target.value);
                setDiagnosis(null);
              }}
            />
          </div>
          <Button type="submit" disabled={busy || name.length === 0 || connString.length === 0}>
            {busy ? "Checking…" : "Check access"}
          </Button>
        </form>

        {error !== null ? (
          <Alert variant="destructive">
            <AlertTitle>Could not check the connection</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {diagnosis !== null && !diagnosis.reachable ? (
          <Alert variant="destructive">
            <AlertTitle>Cannot use this connection string</AlertTitle>
            <AlertDescription>{diagnosis.message}</AlertDescription>
          </Alert>
        ) : null}

        {diagnosis?.reachable === true ? (
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">
              Connected as{" "}
              <code>{diagnosis.username ?? (diagnosis.authEnabled ? "unknown" : "no auth")}</code>
            </p>
            {diagnosis.message !== null ? (
              <p className="mt-1 text-muted-foreground text-xs">{diagnosis.message}</p>
            ) : null}
            <PrivilegeList privileges={diagnosis.privileges} />

            {diagnosis.missing.length > 0 ? (
              <Alert variant="destructive" className="mt-3">
                <AlertTitle>Missing: {diagnosis.missing.join(", ")}</AlertTitle>
                <AlertDescription>
                  {diagnosis.ready
                    ? "The cluster can still be analyzed, but no change can be applied."
                    : "Analysis is not possible without these."}
                </AlertDescription>
              </Alert>
            ) : null}

            {diagnosis.canProvision ? (
              <div className="mt-3 rounded-md bg-muted/40 p-3">
                <p className="font-medium">
                  These credentials can create users — let Indexterity make its own?
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  A dedicated user <code>idx_…</code> is created on your cluster with the{" "}
                  <code>indexterityEngine</code> role: exactly the privileges listed above and
                  nothing else — notably <strong>no read access to your documents</strong>. The
                  admin string you pasted is used once and never stored; only the new user's string
                  is kept (encrypted). Revoke it any time with <code>db.dropUser(…)</code>.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => void onProvision()}>
                    {busy ? "Creating…" : "Create a scoped user and connect"}
                  </Button>
                  {diagnosis.ready ? (
                    <Button variant="outline" disabled={busy} onClick={() => void onConnectAsIs()}>
                      Use these credentials as-is
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : diagnosis.ready ? (
              <Button className="mt-3" disabled={busy} onClick={() => void onConnectAsIs()}>
                Connect
              </Button>
            ) : (
              <p className="mt-2 text-muted-foreground text-xs">
                Grant the missing privileges to this user, or paste credentials that can create
                users and Indexterity will provision a scoped one for you. The exact role is in{" "}
                <code>docs/architecture.md</code> §10.1.
              </p>
            )}
          </div>
        ) : null}

        {provisioned !== null ? (
          <Alert>
            <AlertTitle>
              Created scoped user <code>{provisioned.username}</code> — shown once
            </AlertTitle>
            <AlertDescription className="grid gap-1">
              <code className="break-all font-mono text-xs">{provisioned.connectionString}</code>
              <span className="text-xs">
                Stored encrypted; the admin string was not saved. To revoke access later:{" "}
                <code>db.dropUser("{provisioned.username}")</code> in the admin database.
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
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
  const [renaming, setRenaming] = useState(false);
  const [orgName, setOrgName] = useState(org.name);

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

  async function onRename() {
    const result = await renameOrg({ data: orgName }).catch(() => ({ ok: false }));
    if (result.ok) toast.success("Org renamed");
    else toast.error("Rename failed (owner only)");
    setRenaming(false);
    onChanged();
  }

  async function onSetRole(userId: string, role: "member" | "owner") {
    const result = await setMemberRole({ data: { userId, role } }).catch(() => ({
      ok: false,
      message: "failed",
    }));
    if (result.ok) toast.success(`Role changed to ${role}`);
    else toast.error(result.message ?? "Role change failed");
    onChanged();
  }

  async function onRemove(userId: string) {
    const result = await removeMember({ data: userId }).catch(() => ({
      ok: false,
      message: "failed",
    }));
    if (result.ok) toast.success("Member removed");
    else toast.error(result.message ?? "Remove failed");
    onChanged();
  }

  async function onLeave() {
    const result = await leaveOrg({ data: {} }).catch(() => ({ ok: false, message: "failed" }));
    if (result.ok) toast.success("Left the org");
    else toast.error(result.message ?? "Leave failed");
    onChanged();
  }

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Team — {org.name}</CardTitle>
          {renaming ? (
            <form
              className="flex gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void onRename();
              }}
            >
              <Input
                aria-label="Organization name"
                className="h-8 w-48"
                value={orgName}
                onChange={(event) => setOrgName(event.target.value)}
              />
              <Button type="submit" size="sm">
                Save
              </Button>
            </form>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOrgName(org.name);
                setRenaming(true);
              }}
            >
              Rename
            </Button>
          )}
          <ConfirmButton
            destructive
            trigger={
              <Button variant="ghost" size="sm" className="text-destructive">
                Leave org
              </Button>
            }
            title={`Leave ${org.name}?`}
            description="You lose access to its clusters. The last owner must transfer ownership first."
            confirmLabel="Leave"
            onConfirm={() => void onLeave()}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1">
          {org.members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                {member.name} <span className="text-muted-foreground">({member.email})</span>
              </span>
              <Badge variant="outline">{member.role}</Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void onSetRole(member.userId, member.role === "owner" ? "member" : "owner")
                }
              >
                {member.role === "owner" ? "Make member" : "Make owner"}
              </Button>
              <ConfirmButton
                destructive
                trigger={
                  <Button variant="ghost" size="sm" className="text-destructive">
                    Remove
                  </Button>
                }
                title={`Remove ${member.email}?`}
                description={`They lose access to every cluster in ${org.name}. Their own account stays, in a fresh empty organization.`}
                confirmLabel="Remove"
                onConfirm={() => void onRemove(member.userId)}
              />
            </li>
          ))}
          {org.pendingInvites.map((invite) => (
            <li
              key={invite.email}
              className="flex items-center gap-2 text-muted-foreground text-sm"
            >
              {invite.email}
              <Badge variant="secondary">invited · {invite.role}</Badge>
            </li>
          ))}
        </ul>

        <Separator />

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">Invite a teammate</Label>
            <Input
              id="invite-email"
              type="email"
              className="w-64"
              placeholder="teammate@company.com"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
            />
          </div>
          <Button onClick={() => void onInvite()}>Invite</Button>
        </div>
        {inviteToken !== null ? (
          <Alert>
            <AlertTitle>Invite created</AlertTitle>
            <AlertDescription>
              Share this token: <code className="font-mono">{inviteToken}</code>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="accept-token">Have an invite token?</Label>
            <Input
              id="accept-token"
              className="w-64 font-mono"
              placeholder="Paste an invite token"
              value={acceptToken}
              onChange={(event) => setAcceptToken(event.target.value)}
            />
          </div>
          <Button variant="outline" onClick={() => void onAccept()}>
            Join org
          </Button>
        </div>
        {acceptMessage !== null ? (
          <p className="text-muted-foreground text-sm">{acceptMessage}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AuthForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"in" | "up" | "forgot">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    if (mode === "forgot") {
      const sent = await requestPasswordReset({ data: email }).catch(() => ({
        ok: false,
        error: "request failed",
      }));
      setBusy(false);
      if (sent.ok) setNotice("If that email has an account, a reset link is on its way.");
      else setError("error" in sent ? sent.error : "request failed");
      return;
    }
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
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Indexterity</CardTitle>
          <CardDescription>
            {mode === "in"
              ? "Sign in to your account"
              : mode === "up"
                ? "Create an account"
                : "Reset your password"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {mode === "up" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="auth-name">Name</Label>
                <Input
                  id="auth-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="auth-email">Email</Label>
              <Input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {mode !== "forgot" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="auth-password">Password</Label>
                <Input
                  id="auth-password"
                  type="password"
                  autoComplete={mode === "up" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            ) : null}
            {error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {error}
                  {/* The api rejected sign-up because this instance is
                      invite-only — say what to do next, not just what failed. */}
                  {error.includes("invite-only") ? (
                    <span className="mt-1 block">
                      Already invited? Use the link from the invite email, or{" "}
                      <a href={REQUEST_ACCESS_HREF} className="underline">
                        request access
                      </a>
                      .
                    </span>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {notice !== null ? (
              <Alert>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={busy}>
              {mode === "in" ? "Sign in" : mode === "up" ? "Sign up" : "Send reset link"}
            </Button>
          </form>
          <div className="mt-4 flex flex-col items-start gap-1">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => setMode(mode === "in" ? "up" : "in")}
            >
              {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
            </Button>
            {mode === "in" ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => setMode("forgot")}
              >
                Forgot password?
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
