// Registering and removing WireGuard tunnels.
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
