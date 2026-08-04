// Every server function the dashboard calls, and the small helpers that
// shape their results. Split out of routes/app.tsx: these run on the web
// server, not in the browser, and mixing them into the page made the file
// hard to read as either.
import { ORPCError } from "@orpc/client";
import { createServerFn } from "@tanstack/react-start";
import { serverApi } from "~/lib/api";

// Runs on the web server for every navigation; forwards the session cookie to
// the api. oRPC calls return data directly and throw ORPCError on failure.
// The shape the dashboard renders when the api could not answer. The plan
// block is the most restrictive one, so a transient failure never draws limits
// the org does not have.
const EMPTY_ORG = {
  id: "",
  name: "",
  plan: {
    plan: "FREE",
    maxClusters: 1,
    maxMembers: 3,
    workloadAnalysis: false,
    autoApply: false,
    clustersUsed: 0,
    membersUsed: 0,
  },
  members: [],
  pendingInvites: [],
};

const EMPTY_PIPELINE = {
  recommendations: [],
  roi: { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0, attribution: [] },
  activity: [],
};
const EMPTY_TELEMETRY = {
  latency: { collections: [] },
  latencySeries: { collections: [] },
  collectionStats: { collections: [] },
};

const clusterIdValidator = (id: unknown): string | null => (typeof id === "string" ? id : null);

// "None selected" means the first cluster — the same rule the shell applies.
// Defined once so the three readers below cannot disagree about which cluster
// an unqualified request is about.
async function resolveCluster(
  api: ReturnType<typeof serverApi>,
  selected: string | null,
): Promise<string | null> {
  if (selected !== null) return selected;
  const clusters = await api.listClusters();
  return clusters[0]?.id ?? null;
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ORPCError && error.status === status;
}

// The shell: who is signed in, which orgs they can see, and which clusters
// exist. Every /app route needs it, so it is the layout's loader and is
// fetched once for the whole subtree.
//
// It used to be one loader with the per-cluster reads bolted on, which meant
// opening the team page fetched a latency series nobody was going to look at.
//
// It takes no arguments, and specifically not the selected cluster: which of
// these clusters is on screen is a property of the URL, and resolving it here
// would make every cluster switch a refetch of the org and the member list.
// The shell answers "what exists"; the layout picks one out of it.
export const loadAppShell = createServerFn({ method: "GET" }).handler(async () => {
  const api = serverApi();
  try {
    const [clusters, org, orgs] = await Promise.all([
      api.listClusters(),
      api.getOrg(),
      api.listOrgs(),
    ]);
    return {
      authed: true as const,
      clusters,
      org: org ?? EMPTY_ORG,
      orgs,
    };
  } catch (error) {
    if (isStatus(error, 401)) return { authed: false as const, apiDown: false as const };
    // The api is unreachable — render a friendly state instead of a 500.
    return { authed: false as const, apiDown: true as const };
  }
});

// One cluster's data, grouped by what CHANGES it rather than by what draws it.
//
// It was a single call returning all seven reads, so approving one
// recommendation refetched the latency series and the collection footprint as
// well. Three groups on three clocks:
//
//   pipeline   every mutation — approve, undo, un-hide
//   telemetry  only when the collector runs, hours apart
//   policy     only when someone saves the policy form
//
// Each returns its own empty shape on failure, so one dead read cannot blank
// the other two panels.
export const loadPipeline = createServerFn({ method: "GET" })
  .validator(clusterIdValidator)
  .handler(async ({ data: selected }) => {
    const api = serverApi();
    try {
      const clusterId = await resolveCluster(api, selected);
      if (clusterId === null) return EMPTY_PIPELINE;
      const [recommendations, roi, activity] = await Promise.all([
        api.listRecommendations({ clusterId }),
        api.getRoi({ clusterId }),
        api.listActions({ clusterId }),
      ]);
      return { recommendations, roi, activity };
    } catch {
      return EMPTY_PIPELINE;
    }
  });

export const loadTelemetry = createServerFn({ method: "GET" })
  .validator(clusterIdValidator)
  .handler(async ({ data: selected }) => {
    const api = serverApi();
    try {
      const clusterId = await resolveCluster(api, selected);
      if (clusterId === null) return EMPTY_TELEMETRY;
      const [latency, latencySeries, collectionStats] = await Promise.all([
        api.getLatency({ clusterId }),
        api.getLatencySeries({ clusterId }),
        api.getCollections({ clusterId }),
      ]);
      return { latency, latencySeries, collectionStats };
    } catch {
      return EMPTY_TELEMETRY;
    }
  });

export const loadClusterPolicy = createServerFn({ method: "GET" })
  .validator(clusterIdValidator)
  .handler(async ({ data: selected }) => {
    const api = serverApi();
    try {
      const clusterId = await resolveCluster(api, selected);
      if (clusterId === null) return { policy: null };
      return { policy: await api.getPolicy({ clusterId }) };
    } catch {
      return { policy: null };
    }
  });

export const approveRecommendation = createServerFn({ method: "POST" })
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

export const unhideRecommendation = createServerFn({ method: "POST" })
  .validator((id: unknown): string => {
    if (typeof id !== "string") throw new Error("id must be a string");
    return id;
  })
  .handler(async ({ data }) => {
    try {
      await serverApi().unhideRecommendation({ id: data });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

export const rollbackRecommendation = createServerFn({ method: "POST" })
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

export const createInvite = createServerFn({ method: "POST" })
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

export const acceptInvite = createServerFn({ method: "POST" })
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

export const connectCluster = createServerFn({ method: "POST" })
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
      const message = orpcMessage(error, "failed to connect cluster");
      return { ok: false, message, id: null };
    }
  });

// Statuses whose message is written FOR the reader and can be shown as-is.
// 402 is here because a plan refusal names the plan, the limit and what to do;
// hiding it behind "failed" is how a billing limit gets reported as a bug.
// Everything else keeps a generic message — a 500 must not leak internals.
const READABLE_STATUSES = [400, 402, 403, 404, 409];

function orpcMessage(error: unknown, fallback: string): string {
  return error instanceof ORPCError && READABLE_STATUSES.includes(error.status)
    ? error.message
    : fallback;
}

export const renameOrg = createServerFn({ method: "POST" })
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

export const setMemberRole = createServerFn({ method: "POST" })
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

export const removeMember = createServerFn({ method: "POST" })
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

export const leaveOrg = createServerFn({ method: "POST" })
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
export const rotateConnection = createServerFn({ method: "POST" })
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
export const checkConnection = createServerFn({ method: "POST" })
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
export const provisionCluster = createServerFn({ method: "POST" })
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

export const switchOrgFn = createServerFn({ method: "POST" })
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
export const disconnectCluster = createServerFn({ method: "POST" })
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

export const savePolicy = createServerFn({ method: "POST" })
  .validator((data: unknown): PolicyInput => {
    if (
      typeof data === "object" &&
      data !== null &&
      "clusterId" in data &&
      typeof data.clusterId === "string" &&
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
        workloadAnalysis: data.workloadAnalysis,
        instantCreate: data.instantCreate,
        observeWindowDays: data.observeWindowDays,
        maxCollectionSizeBytes: null,
        autoApplyScore: data.autoApplyScore,
        changeWindowStartHour: data.changeWindowStartHour,
        changeWindowEndHour: data.changeWindowEndHour,
      });
      return { ok: true, message: null };
    } catch (error) {
      // The reason matters now that a save can fail for two different things:
      // the caller is not an owner, or the plan does not include what they
      // switched on. Collapsing both into "owner only" sends half of them
      // looking for a permissions problem they do not have.
      return { ok: false, message: orpcMessage(error, "policy not saved") };
    }
  });

export const setClusterMode = createServerFn({ method: "POST" })
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
