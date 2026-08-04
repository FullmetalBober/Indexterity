// Everything that changes a cluster: its mode, its credentials, whether it
// exists at all.
//
// Each hook owns the key it invalidates, which is why none of them takes an
// onChanged callback. They used to, and the caller had to know that a cluster's
// mode is read from the shell — a fact about the cache leaking into a component
// whose job is drawing badges. What the caller still passes is the local state a
// mutation cannot know about: a form to close, an error to show.
import type { ConnectionDiagnosis } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  checkConnection,
  connectCluster,
  disconnectCluster,
  provisionCluster,
  rotateConnection,
  setClusterMode,
} from "../../app-server";
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
    mutationFn: (readOnly: boolean) => setClusterMode({ data: { clusterId, readOnly } }),
    onSuccess: (result, readOnly) => {
      // A refused change moved nothing, so there is nothing to refetch.
      if (!result.ok) {
        toast.error(MODE_FAILED);
        return;
      }
      toast.success(
        readOnly ? "Cluster is read-only again" : "Live mode enabled — the engine may now write",
      );
      return invalidateShell();
    },
    onError: () => toast.error(MODE_FAILED),
  });
}

export function useRotateConnection(clusterId: string, { onRotated }: { onRotated: () => void }) {
  const invalidateShell = useInvalidateShell();
  return useMutation({
    mutationFn: (connectionString: string) =>
      rotateConnection({ data: { clusterId, connectionString } }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message ?? ROTATION_FAILED);
        return;
      }
      toast.success("Connection string rotated — history preserved");
      onRotated();
      return invalidateShell();
    },
    onError: () => toast.error(ROTATION_FAILED),
  });
}

export function useDisconnectCluster(clusterId: string) {
  const invalidateShell = useInvalidateShell();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => disconnectCluster({ data: clusterId }),
    onSuccess: async (result) => {
      if (!result.ok) {
        // The cluster is still there, so deselecting it would be a lie.
        toast.error(DISCONNECT_FAILED);
        return;
      }
      toast.success(
        result.unhidden > 0
          ? `Disconnected — ${result.unhidden} hidden ${result.unhidden === 1 ? "index" : "indexes"} restored`
          : "Cluster disconnected",
      );
      await navigate({ to: "/app", search: {} });
      await invalidateShell();
    },
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
    mutationFn: (connectionString: string) => checkConnection({ data: connectionString }),
    onMutate: handlers.onStart,
    onSuccess: (result) => {
      if (result.ok) handlers.onDiagnosis(result.diagnosis);
      else handlers.onError(result.message);
    },
    onError: () => handlers.onError("could not check the connection"),
  });
}

interface ConnectHandlers {
  readonly onStart: () => void;
  readonly onConnected: () => void;
  readonly onError: (message: string | null) => void;
}

// The shell first, then the URL: the new cluster has to be in the list before
// the selection points at it, or the bar has a moment of finding nothing under
// ?cluster= and drawing "No cluster connected".
function useLandOnNewCluster() {
  const invalidateShell = useInvalidateShell();
  const navigate = useNavigate();
  return async (id: string | null) => {
    await invalidateShell();
    if (id !== null) await navigate({ to: "/app", search: { cluster: id } });
  };
}

export function useConnectCluster(
  credentials: { name: string; connectionString: string },
  handlers: ConnectHandlers,
) {
  const land = useLandOnNewCluster();
  return useMutation({
    mutationFn: () => connectCluster({ data: credentials }),
    onMutate: handlers.onStart,
    onSuccess: async (result) => {
      if (!result.ok) {
        handlers.onError(result.message);
        return;
      }
      handlers.onConnected();
      await land(result.id);
    },
    onError: () => handlers.onError("failed to connect cluster"),
  });
}

// Consent path: the admin string is used once to create the scoped user and is
// never stored. Its string is shown once, so onProvisioned fires before the
// navigation that clears the form.
export function useProvisionCluster(
  credentials: { name: string; adminConnectionString: string },
  handlers: ConnectHandlers & {
    onProvisioned: (user: { username: string; connectionString: string }) => void;
  },
) {
  const land = useLandOnNewCluster();
  return useMutation({
    mutationFn: () => provisionCluster({ data: credentials }),
    onMutate: handlers.onStart,
    onSuccess: async (result) => {
      if (result.ok && result.username !== null && result.connectionString !== null) {
        handlers.onProvisioned({
          username: result.username,
          connectionString: result.connectionString,
        });
      }
      if (!result.ok) {
        handlers.onError(result.message);
        return;
      }
      handlers.onConnected();
      await land(result.id);
    },
    onError: () => handlers.onError("failed to provision the cluster"),
  });
}
