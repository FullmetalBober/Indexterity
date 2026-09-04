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
  ClusterIndexesInput,
  ClusterIndexSizeSeries,
  ClusterLatencySeries,
  ClusterNodes,
  ClusterWorkload,
  ClusterWorkloadInput,
  CollectionStat,
  LatencySummary,
} from "@repo/contracts";
import { CLUSTER_INDEXES_PAGE, WORKLOAD_SHAPES_PAGE } from "@repo/contracts";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { PagedRead, Read } from "./read";

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

// Which page of the inventory is being asked for: the api's input minus the
// cluster the caller already holds, DERIVED from the contract rather than
// restated (#455). The interface this replaces was a hand copy that stopped at
// `offset`/`limit`, so when `sort`, `dir` and `q` joined the contract (D135) they
// never reached a request — and the compiler could not say so, because a
// variable of a wider type is accepted where a narrower object type is expected,
// with no excess-property check. A field added to the contract is a field here
// now, is forwarded by the spread in the query function below, and is in the key
// (keys.ts), with no second place for it to be left out of.
export type ClusterIndexPage = Readonly<Omit<ClusterIndexesInput, "clusterId">>;

// The whole payload again, and for the third time the same reason: `total` is the
// honest denominator for a page, and `offset`/`limit` are what the pagination
// control reads to know which page it is on and how many there are. Folding any
// of them away here would give the control a page count of zero on a read that
// has not answered, which draws as "no indexes" rather than as "not yet".
//
// `limit` is the api's default rather than 0, because it is a divisor.
export const NO_CLUSTER_INDEXES: ClusterIndexes = {
  clusterId: "",
  indexes: [],
  total: 0,
  offset: 0,
  limit: CLUSTER_INDEXES_PAGE,
  collectedAt: null,
};

// The page is spread whole, not forwarded member by member — the forwarder was
// the third hand copy of the request #455 found short. A member the reader left
// undefined costs nothing either way: the client appends only strings, numbers
// and booleans to the query string (OpenAPILink's serializer), and the cache
// drops undefined members when it hashes the key, so `{ q: undefined }` and `{}`
// are one request and one entry.
//
// No default page. `{}` and the first page in full are the same question to the
// api and two entries to the cache, so every caller says what it is asking for
// — the route's loader and its component from one constant, see the route.
export function clusterIndexesQuery(clusterId: string | null, page: ClusterIndexPage) {
  return queryOptions({
    queryKey: queryKeys.clusterIndexes(clusterId, page),
    queryFn: async () =>
      clusterId === null ? NO_CLUSTER_INDEXES : api().getClusterIndexes({ clusterId, ...page }),
    // The page before this one stays on screen while this one is out — see
    // PagedRead. Without it a new key is a new entry with nothing in it, and
    // every click and keystroke would outline the table and disable the search
    // box mid-word.
    placeholderData: keepPreviousData,
  });
}

// Which page of the scanning workload is being asked for (#432), derived the
// same way and for the same reason as ClusterIndexPage above.
export type WorkloadPage = Readonly<Omit<ClusterWorkloadInput, "clusterId">>;

// `workloadAnalysisEnabled` true in the empty fallback, so a cluster whose read
// has not answered yet does not draw "create-side analysis is off" — that is a
// setting, and claiming it from an absence of data is the same mistake #289 was
// about.
export const NO_CLUSTER_WORKLOAD: ClusterWorkload = {
  clusterId: "",
  shapes: [],
  total: 0,
  offset: 0,
  limit: WORKLOAD_SHAPES_PAGE,
  workloadAnalysisEnabled: true,
  collectionsBelowDocFloor: 0,
  collectionsAboveSizeCeiling: 0,
  analysedAt: null,
};

export function clusterWorkloadQuery(clusterId: string | null, page: WorkloadPage) {
  return queryOptions({
    queryKey: queryKeys.clusterWorkload(clusterId, page),
    queryFn: async () =>
      clusterId === null ? NO_CLUSTER_WORKLOAD : api().getClusterWorkload({ clusterId, ...page }),
    placeholderData: keepPreviousData,
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
// that went on drawing the reassuring empty state after a 500. A PagedRead, with
// `placeholder` beside them: while the next page is out, `data` is the previous
// one, kept on screen on purpose.
export function useClusterIndexes(
  clusterId: string | null,
  page: ClusterIndexPage,
): PagedRead<ClusterIndexes> {
  const {
    data = NO_CLUSTER_INDEXES,
    isPending,
    isError,
    isPlaceholderData,
    refetch,
  } = useQuery(clusterIndexesQuery(clusterId, page));
  return {
    data,
    pending: isPending,
    failed: isError,
    placeholder: isPlaceholderData,
    retry: () => void refetch(),
  };
}

export function useClusterWorkload(
  clusterId: string | null,
  page: WorkloadPage,
): PagedRead<ClusterWorkload> {
  const {
    data = NO_CLUSTER_WORKLOAD,
    isPending,
    isError,
    isPlaceholderData,
    refetch,
  } = useQuery(clusterWorkloadQuery(clusterId, page));
  return {
    data,
    pending: isPending,
    failed: isError,
    placeholder: isPlaceholderData,
    retry: () => void refetch(),
  };
}
