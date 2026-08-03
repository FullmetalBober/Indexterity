import { QueryClient } from "@tanstack/react-query";

// Created once per router. On the server that means once per request, which is
// the point: a module-level singleton would carry one tenant's cache into the
// next request's render. In the browser the router is created once, so this is
// once per tab.
//
// Nothing else may call this. Both the loaders and the provider take the client
// out of router context — see router.tsx. Calling the factory a second time
// produces a second cache, the loaders fill one and the components read the
// other, and every query suspends forever on a client that will never be
// populated.
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // This data moves on the collector's schedule, not the user's.
        // Refetching because a window regained focus buys a round trip to
        // redraw identical numbers.
        refetchOnWindowFocus: false,
        // Zero on purpose, and load-bearing. A loader run means something
        // happened that should refresh the page — a cluster connected, a
        // cluster switched, retry pressed — and ensureQueryData refetches only
        // what it considers stale. A non-zero staleTime here would make
        // router.invalidate() silently stop refreshing anything inside the
        // window. Holding data between renders is what the cache is for;
        // deciding it is still fresh is not.
        staleTime: 0,
        // A failed read renders as an empty panel rather than an error, so two
        // more attempts only delay that.
        retry: 1,
      },
    },
  });
}

// Keys are (resource, cluster). The cluster has to be in the key, or switching
// clusters would show the previous one's numbers while the new ones load.
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

// Signing in, signing out and switching org are the three moments where the
// answer to every question on the page changes at once, because who is asking
// changed. Invalidating one key would leave the previous session's clusters and
// recommendations on screen until something else happened to move them.
//
// This is deliberately the whole cache and nothing less. It is still not
// router.invalidate(): the loaders are not re-run, the cache refetches what is
// mounted and drops the rest.
export function invalidateSession(client: QueryClient): Promise<void> {
  return client.invalidateQueries();
}
