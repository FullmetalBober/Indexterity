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

export interface Tunnels extends Read<TunnelView[]> {
  /**
   * Whether this deployment has a tunnel service at all.
   *
   * Defaults to TRUE while the first request is in flight, which is the opposite
   * of the usual "assume nothing" default and deliberate: `false` renders as "the
   * feature is off", and a page that flashes that before its own data arrives
   * tells the reader something untrue about their deployment. Pending is pending.
   */
  readonly enabled: boolean;
}

export function useTunnels(): Tunnels {
  const { data, isPending, isError, refetch } = useQuery(tunnelsQuery());
  return {
    data: data?.tunnels ?? [],
    enabled: data?.enabled ?? true,
    pending: isPending,
    failed: isError,
    retry: () => void refetch(),
  };
}
