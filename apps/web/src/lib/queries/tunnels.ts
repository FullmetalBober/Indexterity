// The org's WireGuard tunnels (#353).
//
// One key for the whole list rather than one per tunnel, matching the endpoint:
// the dashboard never wants a single tunnel on its own, and the list carries
// handshake health, which is the part that moves.
import type { TunnelView } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { Read } from "./read";

export function tunnelsQuery() {
  return queryOptions({
    queryKey: queryKeys.tunnels(),
    queryFn: () => api().listTunnels({}),
    // Handshake age is a live number. Refetched on a slow cadence rather than
    // pushed: a tunnel's health changes on the scale of minutes, and a socket
    // per dashboard to say so would cost more than it tells anyone.
    refetchInterval: 30_000,
  });
}

export function useTunnels(): Read<TunnelView[]> {
  const { data = [], isPending, isError, refetch } = useQuery(tunnelsQuery());
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}
