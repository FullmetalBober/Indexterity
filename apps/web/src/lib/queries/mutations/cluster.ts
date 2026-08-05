// Everything that changes a cluster: its mode, its credentials, whether it
// exists at all.
//
// Each hook owns the key it invalidates, which is why none of them takes an
// onChanged callback. They used to, and the caller had to know that a cluster's
// mode is read from the shell — a fact about the cache leaking into a component
// whose job is drawing badges. What the caller still passes is the local state a
// mutation cannot know about: a form to close, an error to show.
//
// The api's refusals arrive as thrown ORPCErrors now that nothing wraps them in
// an { ok, message } envelope on the way here, so the reasons are read off the
// error in onError (see ../errors.ts) rather than off a result.
import type { ConnectionDiagnosis } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { api } from "../../api";
import { apiMessage } from "../errors";
import { queryKeys } from "../keys";

// Said the same way whether the api refused or never answered, because from the
// reader's side those are the same event.
const MODE_FAILED = "Mode change failed (owner only)";
const DISCONNECT_FAILED = "Disconnect failed (owner only)";
const ROTATION_FAILED = "rotation failed";

// A cluster's name, mode and provisioned user are all read from the shell, so
// that is the one key any of this moves.
function useInvalidateShell(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.shell() });
}

export function useSetClusterMode(clusterId: string) {
  const invalidateShell = useInvalidateShell();
  return useMutation({
    mutationFn: (readOnly: boolean) => api().setClusterMode({ clusterId, readOnly }),
    onSuccess: (_cluster, readOnly) => {
      toast.success(
        readOnly ? "Cluster is read-only again" : "Live mode enabled — the engine may now write",
      );
      return invalidateShell();
    },
    // A refused change moved nothing, so there is nothing to refetch.
    onError: () => toast.error(MODE_FAILED),
  });
}

// Credential rotation: verified server-side before storing, so a typo can't
// brick the cluster; history survives (unlike disconnect + reconnect).
export function useRotateConnection(clusterId: string, { onRotated }: { onRotated: () => void }) {
  const invalidateShell = useInvalidateShell();
  return useMutation({
    mutationFn: (connectionString: string) =>
      api().rotateConnection({ clusterId, connectionString }),
    onSuccess: () => {
      toast.success("Connection string rotated — history preserved");
      onRotated();
      return invalidateShell();
    },
    // 400 names the problem with the string, 404 the cluster, 502 says the
    // cluster could not be dialled with it — all three are worth reading.
    onError: (error) => toast.error(apiMessage(error, ROTATION_FAILED, [400, 404, 502])),
  });
}

// Offboard a cluster: the api restores in-flight hidden indexes, deletes all
// collected data, and reports how to revoke the provisioned user.
export function useDisconnectCluster(clusterId: string) {
  const invalidateShell = useInvalidateShell();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api().deleteCluster({ clusterId }),
    onSuccess: async (result) => {
      toast.success(
        result.unhidden > 0
          ? `Disconnected — ${result.unhidden} hidden ${result.unhidden === 1 ? "index" : "indexes"} restored`
          : "Cluster disconnected",
      );
      await navigate({ to: "/app", search: {} });
      await invalidateShell();
    },
    // The cluster is still there, so deselecting it would be a lie.
    onError: () => toast.error(DISCONNECT_FAILED),
  });
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
    mutationFn: (connectionString: string) => api().checkConnection({ connectionString }),
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

// The shell first, then the URL: the new cluster has to be in the list before
// the selection points at it, or the bar has a moment of finding nothing under
// ?cluster= and drawing "No cluster connected".
function useLandOnNewCluster() {
  const invalidateShell = useInvalidateShell();
  const navigate = useNavigate();
  return async (id: string) => {
    await invalidateShell();
    await navigate({ to: "/app", search: { cluster: id } });
  };
}

// Credentials arrive with mutate() rather than with the hook call: the form they
// come from is a TanStack Form store, which does not re-render the component on
// every keystroke, so a closure captured at render would send stale values.
export function useConnectCluster(handlers: ConnectHandlers) {
  const land = useLandOnNewCluster();
  return useMutation({
    mutationFn: (credentials: { name: string; connectionString: string }) =>
      api().createCluster(credentials),
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
    mutationFn: (credentials: { name: string; adminConnectionString: string }) =>
      api().provisionCluster(credentials),
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
