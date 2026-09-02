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
  ClusterIndexes,
  ClusterIndexSizeSeries,
  ClusterLatencySeries,
  ClusterNodes,
  ClusterWorkload,
  CollectionStat,
  LatencySummary,
} from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { Read } from "./read";

// Module-level so the identity is stable: these are what a component renders
// when there is genuinely nothing, and a fresh [] each render would re-run every
// memo downstream of it. A FAILED read is a separate state since #289 —
// `Read.failed` — and draws its own panel rather than one of these.
export const NO_LATENCY: LatencySummary[] = [];
// The whole payload: totalCollections is the honest denominator for the
// server-side cap (#64), and folding it away here would silence the cut.
export const NO_SERIES: ClusterLatencySeries = {
  clusterId: "",
  totalCollections: 0,
  collections: [],
};
export const NO_COLLECTIONS: CollectionStat[] = [];
// The whole payload again, for the same reason: the three summary fields are
// read off the DRAWABLE ends of a series that has holes in it, and recomputing
// them from `points` in the browser is exactly the mistake the api computes them
// to avoid (#160).
export const NO_INDEX_SIZE_SERIES: ClusterIndexSizeSeries = {
  clusterId: "",
  firstBytes: null,
  latestBytes: null,
  changeBytes: null,
  points: [],
};

// The cluster is already resolved by the caller — the dashboard's loader picks it
// out of the cluster list with the same selectCluster the bar uses, so the id is
// always concrete (see keys.ts). Null means there is no cluster to ask about, not
// "whichever is first", so there is nothing to fetch and no request to make.
//
// Failures are left to reject. They used to be caught and folded into an empty
// payload, which put the error where no caller could see it. The read hooks below
// still default to empty so nothing has to null-check, and since #289 they carry
// `failed` beside it — because defaulting to empty was only half the fix: the
// error reached the hook and stopped there, and the panel went on drawing the
// reassuring empty state.
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

export function indexSizeSeriesQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.indexSizeSeries(clusterId),
    queryFn: () =>
      clusterId === null ? NO_INDEX_SIZE_SERIES : api().getIndexSizeSeries({ clusterId }),
  });
}

// Which page of the inventory is being asked for. Namespace scope and cursor,
// which is exactly the api's input minus the cluster the caller already holds.
export interface ClusterIndexPage {
  readonly database?: string | undefined;
  readonly collection?: string | undefined;
  readonly afterDatabase?: string | undefined;
  readonly afterCollection?: string | undefined;
  readonly afterIndexName?: string | undefined;
}

// The whole payload again, and for the third time the same reason: `total` is
// the honest denominator for a page of 100, and the three cursor fields are how
// the table knows whether to offer another page at all. Folding any of them away
// here would put the reader back to paging into an empty response to find the
// end.
export const NO_CLUSTER_INDEXES: ClusterIndexes = {
  clusterId: "",
  indexes: [],
  total: 0,
  nextDatabase: null,
  nextCollection: null,
  nextIndexName: null,
  collectedAt: null,
};

// The cursor travels as three fields or none. Half of one would page from a
// namespace boundary the api never named, which is a quietly wrong page rather
// than an error.
function pageInput(page: ClusterIndexPage) {
  return {
    ...(page.database === undefined ? {} : { database: page.database }),
    ...(page.collection === undefined ? {} : { collection: page.collection }),
    ...(page.afterDatabase === undefined ||
    page.afterCollection === undefined ||
    page.afterIndexName === undefined
      ? {}
      : {
          afterDatabase: page.afterDatabase,
          afterCollection: page.afterCollection,
          afterIndexName: page.afterIndexName,
        }),
  };
}

export function clusterIndexesQuery(clusterId: string | null, page: ClusterIndexPage = {}) {
  return queryOptions({
    queryKey: queryKeys.clusterIndexes(clusterId, page),
    queryFn: async () =>
      clusterId === null
        ? NO_CLUSTER_INDEXES
        : api().getClusterIndexes({ clusterId, ...pageInput(page) }),
  });
}

// Which page of the scanning workload is being asked for (#432).
export interface WorkloadPage {
  readonly database?: string | undefined;
  readonly collection?: string | undefined;
  readonly declinedOnly?: boolean | undefined;
  readonly afterWeeklyDocsExamined?: number | undefined;
  readonly afterId?: string | undefined;
}

// `workloadAnalysisEnabled` true in the empty fallback, so a cluster whose read
// has not answered yet does not draw "create-side analysis is off" — that is a
// setting, and claiming it from an absence of data is the same mistake #289 was
// about.
export const NO_CLUSTER_WORKLOAD: ClusterWorkload = {
  clusterId: "",
  shapes: [],
  total: 0,
  nextWeeklyDocsExamined: null,
  nextId: null,
  workloadAnalysisEnabled: true,
  collectionsBelowDocFloor: 0,
  collectionsAboveSizeCeiling: 0,
  analysedAt: null,
};

function workloadInput(page: WorkloadPage) {
  return {
    ...(page.database === undefined ? {} : { database: page.database }),
    ...(page.collection === undefined ? {} : { collection: page.collection }),
    ...(page.declinedOnly === undefined ? {} : { declinedOnly: page.declinedOnly }),
    // Both halves or neither, for the reason the api gives: a cost without its
    // tiebreak would skip a shape that shares it.
    ...(page.afterWeeklyDocsExamined === undefined || page.afterId === undefined
      ? {}
      : {
          afterWeeklyDocsExamined: page.afterWeeklyDocsExamined,
          afterId: page.afterId,
        }),
  };
}

export function clusterWorkloadQuery(clusterId: string | null, page: WorkloadPage = {}) {
  return queryOptions({
    queryKey: queryKeys.clusterWorkload(clusterId, page),
    queryFn: async () =>
      clusterId === null
        ? NO_CLUSTER_WORKLOAD
        : api().getClusterWorkload({ clusterId, ...workloadInput(page) }),
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
  const { data = NO_LATENCY, isPending, isError, refetch } = useQuery(latencyQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useLatencySeries(clusterId: string | null): Read<ClusterLatencySeries> {
  const { data = NO_SERIES, isPending, isError, refetch } = useQuery(latencySeriesQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useCollections(clusterId: string | null): Read<CollectionStat[]> {
  const {
    data = NO_COLLECTIONS,
    isPending,
    isError,
    refetch,
  } = useQuery(collectionsQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useIndexSizeSeries(clusterId: string | null): Read<ClusterIndexSizeSeries> {
  const {
    data = NO_INDEX_SIZE_SERIES,
    isPending,
    isError,
    refetch,
  } = useQuery(indexSizeSeriesQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useNodes(clusterId: string | null): Read<ClusterNodes | null> {
  const { data = null, isPending, isError, refetch } = useQuery(nodesQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

// Its own hook rather than a `useQuery` at the call site, for the reason all six
// above are: `Read` carries `failed` beside the payload, and #289 was the panel
// that went on drawing the reassuring empty state after a 500.
export function useClusterIndexes(
  clusterId: string | null,
  page: ClusterIndexPage = {},
): Read<ClusterIndexes> {
  const {
    data = NO_CLUSTER_INDEXES,
    isPending,
    isError,
    refetch,
  } = useQuery(clusterIndexesQuery(clusterId, page));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useClusterWorkload(
  clusterId: string | null,
  page: WorkloadPage = {},
): Read<ClusterWorkload> {
  const {
    data = NO_CLUSTER_WORKLOAD,
    isPending,
    isError,
    refetch,
  } = useQuery(clusterWorkloadQuery(clusterId, page));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}
