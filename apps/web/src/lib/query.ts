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
        // Zero on purpose, and load-bearing: it is what makes a query refetch
        // when the component reading it mounts. Navigating back to the
        // dashboard, or arriving on it after a mutation elsewhere, refreshes
        // what it draws because of this and not because of the loader.
        //
        // The loader specifically cannot be relied on for that:
        // ensureQueryData resolves with cached data whenever there IS cached
        // data, stale or not — it fetches only when the entry is absent. So a
        // non-zero window here would leave a page showing its previous answer
        // with nothing to correct it. Holding data between renders is what the
        // cache is for; deciding it is still fresh is not.
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
// router.invalidate(): no loader is re-run.
export function invalidateSession(client: QueryClient): Promise<void> {
  // What is mounted refetches in place, so the reader keeps looking at
  // something while the new answer arrives rather than at a blank page.
  const refetching = client.invalidateQueries();
  // What is not mounted has to go rather than be marked stale. ensureQueryData
  // hands back cached data whether it is stale or not, so an entry left here is
  // an entry the next loader would render — the previous org's recommendations,
  // under the next org's cluster list.
  client.removeQueries({ type: "inactive" });
  return refetching;
}
