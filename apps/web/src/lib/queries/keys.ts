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
// The four org-level keys take no cluster: they are the same reads whichever
// cluster is selected, so selecting another is a URL change and not a refetch.
export const queryKeys = {
  // The signed-in user, whatever org is active. "me" is better-auth's session
  // (who am I), the other two are the account page's lists. None take an org:
  // switching orgs changes none of these answers, only signing in or out does —
  // and invalidateSession sweeps the whole cache on those already.
  me: () => ["me"] as const,
  mySessions: () => ["my-sessions"] as const,
  myAccounts: () => ["my-accounts"] as const,

  // Org level.
  clusters: () => ["clusters"] as const,
  org: () => ["org"] as const,
  orgs: () => ["orgs"] as const,
  // Invitations addressed to the READER, from any org — the only org-level read
  // that answers for somebody who is in no org at all, which is exactly who
  // needs it.
  myInvites: () => ["my-invites"] as const,

  // Per cluster.
  recommendations: (clusterId: string | null) => ["recommendations", clusterId] as const,
  roi: (clusterId: string | null) => ["roi", clusterId] as const,
  activity: (clusterId: string | null) => ["activity", clusterId] as const,
  latency: (clusterId: string | null) => ["latency", clusterId] as const,
  latencySeries: (clusterId: string | null) => ["latency-series", clusterId] as const,
  collections: (clusterId: string | null) => ["collections", clusterId] as const,
  // The footprint trend (#160). Its own key beside `collections`, which is the
  // same measurement at one instant: they go stale together, on the collect, but
  // one is a 31-point series and the other is a row per collection, and the page
  // draws them in different places.
  indexSizeSeries: (clusterId: string | null) => ["index-size-series", clusterId] as const,
  nodes: (clusterId: string | null) => ["nodes", clusterId] as const,
  policy: (clusterId: string | null) => ["policy", clusterId] as const,
};
