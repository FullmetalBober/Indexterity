// Registering, editing, testing and removing WireGuard tunnels.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api";
import { apiMessage } from "../errors";
import { queryKeys } from "../keys";

export function useCreateTunnel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: { name: string; config: string }) => api().createTunnel(draft),
    onSuccess: (tunnel) => {
      toast.success(`Tunnel "${tunnel.name}" registered`);
      return queryClient.invalidateQueries({ queryKey: queryKeys.tunnels() });
    },
    // The api's message is the parser's own sentence — which directive was
    // wrong and why — so it is shown verbatim rather than replaced with
    // "invalid config", which would tell somebody holding a file they did not
    // write nothing they can act on.
    onError: (error) => toast.error(apiMessage(error, "Could not register that tunnel")),
  });
}

export function useUpdateTunnel() {
  const queryClient = useQueryClient();
  return useMutation({
    // Only what changed is sent. A rename carries no config — the stored
    // PrivateKey is never shown, so there is nothing to prefill and nothing to
    // send back — and replacing the config is a separate decision an owner
    // makes when a key is rotated or a gateway moves.
    mutationFn: (draft: { tunnelId: string; name?: string; config?: string }) =>
      api().updateTunnel(draft),
    onSuccess: (tunnel) => {
      toast.success(`Tunnel "${tunnel.name}" saved`);
      return queryClient.invalidateQueries({ queryKey: queryKeys.tunnels() });
    },
    // The parser's own sentence again, verbatim, for the same reason as on
    // create: it names the directive.
    onError: (error) => toast.error(apiMessage(error, "Could not save that change")),
  });
}

export function useTestTunnel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tunnelId: string) => api().testTunnel({ tunnelId }),
    onSuccess: (result) => {
      // A gateway that did not answer is a successful request with a negative
      // answer, not a failed one. It gets an error-toned toast because it is bad
      // news, and the row keeps the verdict afterwards — a toast that has faded
      // is no use to somebody now editing the config it was about.
      if (result.reachable) toast.success("The gateway answered");
      else toast.error(result.error ?? "The gateway did not answer");
      // Health and handshake age just moved, for this tunnel and possibly for
      // the count of what is up.
      return queryClient.invalidateQueries({ queryKey: queryKeys.tunnels() });
    },
    onError: (error) => toast.error(apiMessage(error, "Could not test that tunnel")),
  });
}

export function useDeleteTunnel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tunnelId: string) => api().deleteTunnel({ tunnelId }),
    onSuccess: () => {
      toast.success("Tunnel removed");
      return queryClient.invalidateQueries({ queryKey: queryKeys.tunnels() });
    },
    // A refusal here names how many clusters still use it, which is the only
    // thing that tells the owner what to do next.
    onError: (error) => toast.error(apiMessage(error, "Could not remove that tunnel")),
  });
}

export function useSetClusterTunnel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: { clusterId: string; tunnelId: string | null }) =>
      api().setClusterTunnel(draft),
    onSuccess: async (_cluster, draft) => {
      toast.success(
        draft.tunnelId === null ? "Cluster dials directly" : "Cluster routed through the tunnel",
      );
      // Both: the cluster's own row changed, and the tunnel list carries a
      // per-tunnel cluster count that decides whether a delete is offered.
      await queryClient.invalidateQueries({ queryKey: queryKeys.clusters() });
      return queryClient.invalidateQueries({ queryKey: queryKeys.tunnels() });
    },
    onError: (error) =>
      toast.error(apiMessage(error, "Could not change how this cluster is reached")),
  });
}
