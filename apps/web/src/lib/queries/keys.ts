// Every cache key in the app, in one place, because a key written twice is two
// keys: the loader fills one, the component reads the other, and the page waits
// forever on data that arrived somewhere else.
//
// Keys are (resource, cluster). The cluster has to be in the key, or switching
// clusters would show the previous one's numbers while the new ones load — and
// it has to be a CONCRETE id. "None selected" resolves to the first cluster, so
// a key of null meant no cluster before one existed and cluster X afterwards:
// one entry, two answers. See the dashboard loader.
//
// The shell is the exception and takes no cluster: clusters, org and orgs are
// the same three reads whichever one is selected, so selecting another is a URL
// change and not a refetch.
export const queryKeys = {
  shell: () => ["shell"] as const,
  pipeline: (clusterId: string | null) => ["pipeline", clusterId] as const,
  telemetry: (clusterId: string | null) => ["telemetry", clusterId] as const,
  policy: (clusterId: string | null) => ["policy", clusterId] as const,
};
