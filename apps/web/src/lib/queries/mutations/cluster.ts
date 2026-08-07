// Everything that changes a cluster: its mode, its credentials, whether it
// exists at all.
//
// Each hook owns the key it invalidates, which is why none of them takes an
// onChanged callback. They used to, and the caller had to know which cache entry
// a cluster's mode is read from — a fact about the cache leaking into a component
// whose job is drawing badges. What the caller still passes is the local state a
// mutation cannot know about: a form to close, an error to show.
//
// The api's refusals arrive as thrown ORPCErrors now that nothing wraps them in
// an { ok, message } envelope on the way here, so the reasons are read off the
// error in onError (see ../errors.ts) rather than off a result.
import type { ConnectionDiagnosis, TlsOverrides } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { api } from "../../api";
import { apiMessage, isSessionStale } from "../errors";
import { queryKeys } from "../keys";

// Said the same way whether the api refused or never answered, because from the
// reader's side those are the same event.
const MODE_FAILED = "Mode change failed (owner only)";
const DISCONNECT_FAILED = "Disconnect failed (owner only)";
const ROTATION_FAILED = "rotation failed";
const RENAME_FAILED = "Rename failed (owner only)";

// A cluster's name, mode and provisioned user all live in the cluster list, so
// that is the only key those three move. It used to be the `shell` key, which held
// the org and the member list in the same entry — so flipping a cluster to live
// refetched the team page's data as a side effect.
function useInvalidateClusters(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.clusters() });
}

// Creating or deleting one moves the org as well, which is not obvious and is
// worth stating: `plan.clustersUsed` is part of the org payload, because the api
// resolves the plan's usage server-side so the dashboard can show a limit before
// someone hits it. So the count that says "1 / 1 clusters" lives under the org
// key while the list it counts lives under this one.
//
// The old `shell` key covered this by accident — one entry held both, so any
// cluster write refreshed the counter for free. Splitting the keys made the
// dependency explicit, and it showed up as a stale "0 / 1 clusters" on the team
// page immediately after connecting a cluster.
function useInvalidateClusterCount(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.clusters() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.org() }),
    ]);
  };
}

// `onStale` is how the fresh-session refusal (#52) reaches the reader as a
// password prompt instead of a failure toast: the hook hands back a retry that
// re-fires this exact mutation, and the dialog invokes it once the sign-in
// lands. Only the three acts the api gates this way take it.
export function useSetClusterMode(
  clusterId: string,
  { onStale }: { onStale: (retry: () => void) => void },
) {
  const invalidateClusters = useInvalidateClusters();
  const mutation = useMutation({
    mutationFn: (readOnly: boolean) => api().setClusterMode({ clusterId, readOnly }),
    onSuccess: (_cluster, readOnly) => {
      toast.success(
        readOnly ? "Cluster is read-only again" : "Live mode enabled — the engine may now write",
      );
      return invalidateClusters();
    },
    // A refused change moved nothing, so there is nothing to refetch.
    onError: (error, readOnly) => {
      if (isSessionStale(error)) onStale(() => mutation.mutate(readOnly));
      else toast.error(MODE_FAILED);
    },
  });
  return mutation;
}

// The name is what the rail, the cluster heading and every alert subject line
// read, and all three come from the cluster list — so one key covers them.
//
// The api refuses a name another cluster in the org already has, which is a 400
// worth reading: "pick another name" is actionable, "rename failed" is not.
export function useRenameCluster(clusterId: string, { onRenamed }: { onRenamed: () => void }) {
  const invalidateClusters = useInvalidateClusters();
  return useMutation({
    mutationFn: (name: string) => api().renameCluster({ clusterId, name }),
    onSuccess: async (cluster) => {
      toast.success(`Renamed to "${cluster.name}"`);
      onRenamed();
      await invalidateClusters();
    },
    onError: (error) => toast.error(apiMessage(error, RENAME_FAILED, [400, 404])),
  });
}

// Credential rotation: verified server-side before storing, so a typo can't
// brick the cluster; history survives (unlike disconnect + reconnect).
export function useRotateConnection(
  clusterId: string,
  { onRotated, onStale }: { onRotated: () => void; onStale: (retry: () => void) => void },
) {
  const invalidateClusters = useInvalidateClusters();
  const mutation = useMutation({
    mutationFn: (connectionString: string) =>
      api().rotateConnection({ clusterId, connectionString }),
    onSuccess: () => {
      toast.success("Connection string rotated — history preserved");
      onRotated();
      return invalidateClusters();
    },
    // 400 names the problem with the string, 404 the cluster, 502 says the
    // cluster could not be dialled with it — all three are worth reading.
    onError: (error, connectionString) => {
      if (isSessionStale(error)) onStale(() => mutation.mutate(connectionString));
      else toast.error(apiMessage(error, ROTATION_FAILED, [400, 404, 502]));
    },
  });
  return mutation;
}

// Offboard a cluster: the api restores in-flight hidden indexes, deletes all
// collected data, and reports how to revoke the provisioned user.
export function useDisconnectCluster(
  clusterId: string,
  { onStale }: { onStale: (retry: () => void) => void },
) {
  const invalidateClusterCount = useInvalidateClusterCount();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () => api().deleteCluster({ clusterId }),
    onSuccess: async (result) => {
      toast.success(
        result.unhidden > 0
          ? `Disconnected — ${result.unhidden} hidden ${result.unhidden === 1 ? "index" : "indexes"} restored`
          : "Cluster disconnected",
      );
      // The list first, then the navigation — the same order as landing on a
      // new cluster, and for the same reason. /app resolves what to show from
      // the cluster list, and navigating first would resolve it from a list
      // that still contains the cluster just deleted.
      await invalidateClusterCount();
      await navigate({ to: "/app" });
    },
    // The cluster is still there, so leaving its page would be a lie.
    onError: (error) => {
      if (isSessionStale(error)) onStale(() => mutation.mutate());
      else toast.error(DISCONNECT_FAILED);
    },
  });
  return mutation;
}

// Preflight: ask the api what these credentials may do before storing them.
// Nothing is stored and nothing is written on the cluster, so nothing is
// invalidated either — the answer is state for the form, not for the cache.
export function useCheckConnection(handlers: {
  onStart: () => void;
  onDiagnosis: (diagnosis: ConnectionDiagnosis) => void;
  onError: (message: string) => void;
}) {
  return useMutation({
    mutationFn: (input: { connectionString: string; tlsOverrides: TlsOverrides }) =>
      api().checkConnection(input),
    onMutate: handlers.onStart,
    onSuccess: handlers.onDiagnosis,
    onError: (error) =>
      handlers.onError(apiMessage(error, "could not check the connection", [400, 403, 502])),
  });
}

interface ConnectHandlers {
  readonly onStart: () => void;
  readonly onConnected: () => void;
  readonly onError: (message: string) => void;
}

// The list first, then the URL: the cluster's own route redirects away from an
// id the cluster list does not contain, so navigating before the list has the
// new one in it would bounce straight back to /app.
function useLandOnNewCluster() {
  const invalidateClusterCount = useInvalidateClusterCount();
  const navigate = useNavigate();
  return async (id: string) => {
    await invalidateClusterCount();
    await navigate({ to: "/app/clusters/$clusterId", params: { clusterId: id } });
  };
}

// Credentials arrive with mutate() rather than with the hook call: the form they
// come from is a TanStack Form store, which does not re-render the component on
// every keystroke, so a closure captured at render would send stale values.
export function useConnectCluster(handlers: ConnectHandlers) {
  const land = useLandOnNewCluster();
  return useMutation({
    mutationFn: (credentials: {
      name: string;
      connectionString: string;
      tlsOverrides: TlsOverrides;
    }) => api().createCluster(credentials),
    onMutate: handlers.onStart,
    onSuccess: async (created) => {
      handlers.onConnected();
      await land(created.id);
    },
    onError: (error) => handlers.onError(apiMessage(error, "failed to connect cluster")),
  });
}

// Consent path: the admin string is used once to create the scoped user and is
// never stored. Its string is shown once, so onProvisioned fires before the
// navigation that clears the form.
export function useProvisionCluster(
  handlers: ConnectHandlers & {
    onProvisioned: (user: { username: string; connectionString: string }) => void;
  },
) {
  const land = useLandOnNewCluster();
  return useMutation({
    mutationFn: (credentials: {
      name: string;
      adminConnectionString: string;
      tlsOverrides: TlsOverrides;
    }) => api().provisionCluster(credentials),
    onMutate: handlers.onStart,
    onSuccess: async (created) => {
      handlers.onProvisioned({
        username: created.username,
        connectionString: created.connectionString,
      });
      handlers.onConnected();
      await land(created.cluster.id);
    },
    // 400 bad string, 422 provision denied, 502 unreachable all carry guidance.
    onError: (error) =>
      handlers.onError(apiMessage(error, "failed to provision the cluster", [400, 422, 502])),
  });
}
