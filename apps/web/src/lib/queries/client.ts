import { QueryClient } from "@tanstack/react-query";
import { isStatus } from "./errors";

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
        // This is the only setting that decides whether mounting a component
        // refetches what it reads, and mounting is what happens right after
        // hydration — so at zero, every page load asked the api for everything
        // a second time, milliseconds after the server had asked for it, and
        // threw the first answer away. The SSR payload carries each entry's
        // dataUpdatedAt from the server, so any window at all ends that.
        //
        // Thirty seconds, because nothing here needs to be fresher than that
        // without something saying so:
        //
        //   own changes    every mutation invalidates its key, which forces a
        //                  refetch whatever this is set to
        //   the collector  runs hours apart
        //   the worker     ticks in the background
        //   a teammate     invites, renames, changes a role — the only case
        //                  this window is really for, and half a minute after
        //                  a navigation is soon enough to see it
        //
        // What makes a window safe at all is that a session change removes the
        // previous session's entries rather than marking them stale — see
        // invalidateSession. Without that, signing in would show the last
        // account's dashboard for the length of this.
        //
        // Deliberately under gcTime (5 minutes): a window longer than that
        // would let an inactive entry be collected while still counted fresh,
        // which is a window that does nothing.
        staleTime: 30_000,
        // Two attempts, and the reasoning changed under it (#289). It used to be
        // "a failed read renders as an empty panel rather than an error, so more
        // attempts only delay that" — which was true, and was the bug. A failure
        // is now visible and carries its own Try again, so the number is about
        // the reader's time rather than about hiding the outcome: one silent
        // retry covers the blip, and anything past that is better spent telling
        // them than making them wait.
        //
        // Except a 401, which is not a blip: it is the api answering the
        // question. Asking it a second time sends the same absent cookie and
        // gets the same answer, so the retry bought nothing and DOUBLED it —
        // the /app shell reads four org-level keys, so one signed-out visit was
        // eight 401s where four would do, and every reload paid it again
        // (measured in the hosted deployment's logs).
        //
        // Written as a predicate rather than `retry: 0` for 401 alone, because
        // the reason is specific to a definitive answer. A 500 or a dropped
        // connection still gets its second attempt.
        retry: (failureCount, error) => !isStatus(error, 401) && failureCount < 1,
      },
    },
  });
}

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
