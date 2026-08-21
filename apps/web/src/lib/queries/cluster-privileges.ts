// What the credentials one cluster is stored on actually hold, re-checked against
// the cluster now (#313).
//
// The second read in the app that DIALS the customer's cluster, and unlike the
// database list beside it this one is not prefetched: the settings route loads
// without it and the card fetches when the reader asks. Both dial a production
// server; making every settings page view pay for two round trips — for a panel
// most visits never open — is how a settings page becomes slow.
//
// `enabled` is what expresses that. The query exists from the first render so the
// button has something to enable, and it does nothing at all until it is switched
// on.
import type { ClusterPrivileges } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { Read } from "./read";

const FIVE_MINUTES = 5 * 60 * 1000;

export function clusterPrivilegesQuery(clusterId: string | null, enabled: boolean) {
  return queryOptions({
    queryKey: queryKeys.clusterPrivileges(clusterId),
    queryFn: async () =>
      clusterId === null ? null : await api().getClusterPrivileges({ clusterId }),
    enabled: enabled && clusterId !== null,
    // Grants change on the order of months and every read costs a dial, so a
    // collapse-and-reopen must not spend another one. The card shows when the
    // answer was taken and offers to ask again, which is the honest version of a
    // refresh.
    staleTime: FIVE_MINUTES,
    // A cluster that cannot be reached is not one whose privilege panel should
    // retry three times before saying so — and every attempt spends the caller's
    // dial budget. The panel says the read failed and offers the retry.
    retry: false,
  });
}

// Null is "not asked yet, or asked and failed". `pending` only means something
// once the query is enabled — a disabled query is pending forever in react-query,
// which would draw a permanent skeleton if the card believed it.
export function useClusterPrivileges(
  clusterId: string | null,
  enabled: boolean,
): Read<ClusterPrivileges | null> {
  const {
    data = null,
    isPending,
    isError,
    refetch,
  } = useQuery(clusterPrivilegesQuery(clusterId, enabled));
  return {
    data,
    pending: enabled && isPending,
    failed: isError,
    retry: () => void refetch(),
  };
}
