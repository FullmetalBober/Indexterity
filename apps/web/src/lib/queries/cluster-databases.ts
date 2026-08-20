// The databases one cluster has, and which of them are observed (#244).
//
// The only read in the app that DIALS the customer's cluster on a page view, so
// it is deliberately not folded into the cluster list: a rename must not cost a
// connection to somebody's production server. `staleTime` for the same reason —
// the set of databases on a cluster changes on the order of weeks, and the screen
// that draws it has a re-read button of its own.
import type { ClusterDatabases } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { Read } from "./read";

const FIVE_MINUTES = 5 * 60 * 1000;

export function clusterDatabasesQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.clusterDatabases(clusterId),
    queryFn: async () =>
      clusterId === null ? null : await api().listClusterDatabases({ clusterId }),
    staleTime: FIVE_MINUTES,
    // A cluster that cannot be reached right now is not a cluster whose settings
    // page should retry three times before saying so — the section says the read
    // failed and offers the retry, which is the honest version of the same thing.
    retry: false,
  });
}

// Null means the section draws nothing: no cluster, or a read that failed because
// the cluster is unreachable. `pending` is the third state, which gets an outline
// rather than nothing — see read.ts.
export function useClusterDatabases(clusterId: string | null): Read<ClusterDatabases | null> {
  const { data = null, isPending, isError, refetch } = useQuery(clusterDatabasesQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}
