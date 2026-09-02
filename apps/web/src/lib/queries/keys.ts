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
  // Which engines this BUILD can connect (#239) — not an org read at all, and the
  // one answer here that cannot go stale while the tab is open, since it changes
  // only when the api is redeployed. No org in the key for that reason: switching
  // orgs cannot change it, so it must not refetch.
  engines: () => ["engines"] as const,
  // The org's security trail (#158). The filter and the page cursor are IN the
  // key: they are what the api was asked, so two filters are two answers, and
  // one entry holding both would show the previous filter's rows under the new
  // one's heading while it loaded.
  securityEvents: (filter: {
    event?: string | undefined;
    actorUserId?: string | undefined;
    beforeCreatedAt?: string | undefined;
    beforeId?: string | undefined;
  }) =>
    [
      "security-events",
      filter.event ?? null,
      filter.actorUserId ?? null,
      filter.beforeCreatedAt ?? null,
      filter.beforeId ?? null,
    ] as const,

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
  // One page of the cluster's index inventory (#431). The namespace filter and
  // the page cursor are IN the key for the same reason the security trail's are:
  // they are what the api was ASKED, so two cursors are two answers, and one
  // entry holding both would draw the previous page's rows under the next page's
  // heading while it loaded.
  clusterIndexes: (
    clusterId: string | null,
    filter: {
      database?: string | undefined;
      collection?: string | undefined;
      afterDatabase?: string | undefined;
      afterCollection?: string | undefined;
      afterIndexName?: string | undefined;
    },
  ) =>
    [
      "cluster-indexes",
      clusterId,
      filter.database ?? null,
      filter.collection ?? null,
      filter.afterDatabase ?? null,
      filter.afterCollection ?? null,
      filter.afterIndexName ?? null,
    ] as const,
  // Every page of that inventory, as a PREFIX. TanStack Query matches
  // invalidations by prefix, and an event moves the whole inventory rather than
  // the one page a reader happens to be on — so an invalidation written with a
  // concrete cursor would miss every other page and leave them to be served
  // stale from the cache.
  clusterIndexesAll: (clusterId: string | null) => ["cluster-indexes", clusterId] as const,
  // Its own key rather than a field on `recommendations`: a cooldown outlives
  // the recommendation that caused it, and the two are moved by different
  // writes — a regression parks an index without touching the proposal list.
  cooldowns: (clusterId: string | null) => ["cooldowns", clusterId] as const,
  policy: (clusterId: string | null) => ["policy", clusterId] as const,
  // Which databases a cluster HAS, for the observe checkboxes (#244). Its own key
  // and not part of the cluster list: this one is a live dial to the customer's
  // cluster, so it must not be refetched by every rename and mode flip that
  // invalidates the list.
  clusterDatabases: (clusterId: string | null) => ["cluster-databases", clusterId] as const,
  // What the STORED credentials hold, re-checked against the cluster (#313). Its
  // own key beside `clusterDatabases` and for the same reason: this one dials the
  // customer's cluster, so it must not be swept by the rename and mode flips that
  // invalidate the list — and it must not be swept by a rotation either. A
  // rotation replaces the credentials this describes, so that one invalidates it
  // on purpose.
  clusterPrivileges: (clusterId: string | null) => ["cluster-privileges", clusterId] as const,
  // The org's WireGuard tunnels (#353). Org-scoped, not per cluster: one peering
  // commonly reaches several, and the list carries live handshake health, so it
  // must not be swept by every cluster-level write.
  tunnels: () => ["tunnels"] as const,
};
