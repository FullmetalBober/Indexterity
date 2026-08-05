// Every cache key in the app, in one place, because a key written twice is two
// keys: the loader fills one, the component reads the other, and the page waits
// forever on data that arrived somewhere else.
//
// **One key per api call.** These used to be grouped by what *changes* them —
// `shell`, `pipeline`, `telemetry` — with three endpoints behind each, fetched
// together by a Promise.all and cached as one blob. That grouping was a claim
// about the writes imposed on the reads, and the reads paid for it: the org page
// pulled a cluster list it never draws, the latency chart could not fail without
// blanking the collection table beside it, and flipping a cluster to live
// refetched the member list. One entry holding three answers is three questions
// sharing a cache line.
//
// Cluster-scoped keys are (resource, cluster). The cluster has to be in the key,
// or switching clusters would show the previous one's numbers while the new ones
// load — and it has to be a CONCRETE id. "None selected" resolves to the first
// cluster, so a key of null meant no cluster before one existed and cluster X
// afterwards: one entry, two answers. See the dashboard loader.
//
// The three org-level keys take no cluster: they are the same reads whichever
// cluster is selected, so selecting another is a URL change and not a refetch.
export const queryKeys = {
  // Org level.
  clusters: () => ["clusters"] as const,
  org: () => ["org"] as const,
  orgs: () => ["orgs"] as const,

  // Per cluster.
  recommendations: (clusterId: string | null) => ["recommendations", clusterId] as const,
  roi: (clusterId: string | null) => ["roi", clusterId] as const,
  activity: (clusterId: string | null) => ["activity", clusterId] as const,
  latency: (clusterId: string | null) => ["latency", clusterId] as const,
  latencySeries: (clusterId: string | null) => ["latency-series", clusterId] as const,
  collections: (clusterId: string | null) => ["collections", clusterId] as const,
  policy: (clusterId: string | null) => ["policy", clusterId] as const,
};
