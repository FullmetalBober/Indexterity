// The one query every signed-in page reads: who is signed in, which orgs they
// can see, which clusters exist.
//
// Kept in one place because four callers share it — the /app loader fills it,
// and the layout, the dashboard and the org page read it back. Two of them
// writing the same key with two different query functions is how a cache ends
// up with two answers for one question.
//
// It runs on the web server during SSR and in the browser afterwards, off the
// same isomorphic client (lib/api.ts). It used to be a server function, which
// meant the browser asked the web server to ask the api; now it asks the api.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { isStatus } from "./errors";
import { queryKeys } from "./keys";

// Three reads, one answer. They are fetched together because no /app page is
// useful without all three, and separately from anything about a cluster: which
// cluster is on screen is a property of the URL, and resolving it here would
// make every cluster switch a refetch of the org and the member list.
//
// A failure is not an error to render. 401 means signed out and anything else
// means the api could not be asked — both are answers the layout knows how to
// draw, which is why this catches rather than letting the query reject.
async function loadShell() {
  const client = api();
  try {
    const [clusters, org, orgs] = await Promise.all([
      client.listClusters(),
      client.getOrg(),
      client.listOrgs(),
    ]);
    return { authed: true as const, clusters, org, orgs };
  } catch (error) {
    if (isStatus(error, 401)) return { authed: false as const, apiDown: false as const };
    // The api is unreachable — render a friendly state instead of a 500.
    return { authed: false as const, apiDown: true as const };
  }
}

export type Shell = Awaited<ReturnType<typeof loadShell>>;

export function shellQuery() {
  return queryOptions({
    queryKey: queryKeys.shell(),
    queryFn: loadShell,
  });
}

// What the layout draws when it has no shell at all: the unreachable-API card,
// whose Retry refetches this key. Reachable only if the cache were empty, which
// the /app loader and the SSR payload between them rule out — but "we could not
// ask" is the honest answer to have here rather than a signed-out one, which
// would show the sign-in form to someone who is signed in.
const NO_ANSWER = { authed: false as const, apiDown: true as const };

export function useShell(): Shell {
  const { data = NO_ANSWER } = useQuery(shellQuery());
  return data;
}

// Which cluster a page is about. The shell says what exists, the URL says which
// one is selected, and "none selected" means the first. Defined once so the
// cluster bar and the dashboard's cache keys cannot disagree — they did, and one
// entry then held two different clusters' answers.
export function selectCluster<T extends { readonly id: string }>(
  clusters: readonly T[],
  selected: string | null | undefined,
): T | null {
  return clusters.find((entry) => entry.id === selected) ?? clusters[0] ?? null;
}
