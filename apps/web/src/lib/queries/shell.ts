// The one query every signed-in page reads: who is signed in, which orgs they
// can see, which clusters exist.
//
// Kept in one place because four callers share it — the /app loader fills it,
// and the layout, the dashboard and the org page read it back. Two of them
// writing the same key with two different query functions is how a cache ends
// up with two answers for one question.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { loadAppShell } from "../app-server";
import { queryKeys } from "./keys";

export type Shell = Awaited<ReturnType<typeof loadAppShell>>;

export function shellQuery() {
  return queryOptions({
    queryKey: queryKeys.shell(),
    queryFn: () => loadAppShell(),
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
