// What the collector moves, hours apart: the latency summary, the series behind
// the charts, and the per-collection index footprint.
//
// Three endpoints, three queries, three cache entries. They used to be one entry
// filled by a Promise.all, which coupled them in the two ways that matter: the
// chart could not fail without blanking the table beside it, and a page wanting
// one of the three fetched all three. Nothing about the collector's schedule
// required them to share an entry — that is a fact about *why* they go stale, not
// about who reads them.
import type {
  ClusterLatencySeries,
  ClusterNodes,
  CollectionStat,
  LatencySummary,
} from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { Read } from "./read";

// Module-level so the identity is stable: these are what a component renders on
// an absent or failed read, and a fresh [] each render would re-run every memo
// downstream of it.
export const NO_LATENCY: LatencySummary[] = [];
// The whole payload: totalCollections is the honest denominator for the
// server-side cap (#64), and folding it away here would silence the cut.
export const NO_SERIES: ClusterLatencySeries = {
  clusterId: "",
  totalCollections: 0,
  collections: [],
};
export const NO_COLLECTIONS: CollectionStat[] = [];

// The cluster is already resolved by the caller — the dashboard's loader picks it
// out of the cluster list with the same selectCluster the bar uses, so the id is
// always concrete (see keys.ts). Null means there is no cluster to ask about, not
// "whichever is first", so there is nothing to fetch and no request to make.
//
// Failures are left to reject. They used to be caught and folded into an empty
// payload, which put the error where no caller could see it. The read hooks below
// default to empty on their own, so a dead read still draws an empty panel rather
// than an error — and `isError` is now available to anything that wants to say
// more than that.
export function latencyQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.latency(clusterId),
    queryFn: async () =>
      clusterId === null ? NO_LATENCY : (await api().getLatency({ clusterId })).collections,
  });
}

export function latencySeriesQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.latencySeries(clusterId),
    queryFn: async () => (clusterId === null ? NO_SERIES : api().getLatencySeries({ clusterId })),
  });
}

export function collectionsQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.collections(clusterId),
    queryFn: async () =>
      clusterId === null ? NO_COLLECTIONS : (await api().getCollections({ clusterId })).collections,
  });
}

// The whole payload, not just the array: collectedAt is the panel's "as of",
// and a roster without its moment is a topology claim nobody made (#100).
export function nodesQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.nodes(clusterId),
    queryFn: async (): Promise<ClusterNodes | null> =>
      clusterId === null ? null : api().getNodes({ clusterId }),
  });
}

// Each returns the payload AND whether this is the first fetch — see read.ts for
// why the bare payload was not enough.
export function useLatency(clusterId: string | null): Read<LatencySummary[]> {
  const { data = NO_LATENCY, isPending } = useQuery(latencyQuery(clusterId));
  return { data, pending: isPending };
}

export function useLatencySeries(clusterId: string | null): Read<ClusterLatencySeries> {
  const { data = NO_SERIES, isPending } = useQuery(latencySeriesQuery(clusterId));
  return { data, pending: isPending };
}

export function useCollections(clusterId: string | null): Read<CollectionStat[]> {
  const { data = NO_COLLECTIONS, isPending } = useQuery(collectionsQuery(clusterId));
  return { data, pending: isPending };
}

export function useNodes(clusterId: string | null): Read<ClusterNodes | null> {
  const { data = null, isPending } = useQuery(nodesQuery(clusterId));
  return { data, pending: isPending };
}
