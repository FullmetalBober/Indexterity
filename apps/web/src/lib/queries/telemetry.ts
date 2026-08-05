// What the collector moves, hours apart: the latency summary, the series behind
// the charts, and the per-collection index footprint.
//
// Three endpoints, three queries, three cache entries. They used to be one entry
// filled by a Promise.all, which coupled them in the two ways that matter: the
// chart could not fail without blanking the table beside it, and a page wanting
// one of the three fetched all three. Nothing about the collector's schedule
// required them to share an entry — that is a fact about *why* they go stale, not
// about who reads them.
import type { CollectionLatencySeries, CollectionStat, LatencySummary } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

// Module-level so the identity is stable: these are what a component renders on
// an absent or failed read, and a fresh [] each render would re-run every memo
// downstream of it.
export const NO_LATENCY: LatencySummary[] = [];
export const NO_SERIES: CollectionLatencySeries[] = [];
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
    queryFn: async () =>
      clusterId === null ? NO_SERIES : (await api().getLatencySeries({ clusterId })).collections,
  });
}

export function collectionsQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.collections(clusterId),
    queryFn: async () =>
      clusterId === null ? NO_COLLECTIONS : (await api().getCollections({ clusterId })).collections,
  });
}

export function useLatency(clusterId: string | null): LatencySummary[] {
  const { data = NO_LATENCY } = useQuery(latencyQuery(clusterId));
  return data;
}

export function useLatencySeries(clusterId: string | null): CollectionLatencySeries[] {
  const { data = NO_SERIES } = useQuery(latencySeriesQuery(clusterId));
  return data;
}

export function useCollections(clusterId: string | null): CollectionStat[] {
  const { data = NO_COLLECTIONS } = useQuery(collectionsQuery(clusterId));
  return data;
}
