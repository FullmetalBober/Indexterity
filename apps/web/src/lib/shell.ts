// The one query every signed-in page reads: who is signed in, which orgs they
// can see, which clusters exist.
//
// Kept in one place because four callers share it — the /app loader fills it,
// and the layout, the dashboard and the org page read it back. Two of them
// writing the same key with two different query functions is how a cache ends
// up with two answers for one question.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { loadAppShell } from "./app-server";
import { queryKeys } from "./query";

export type Shell = Awaited<ReturnType<typeof loadAppShell>>;

export function shellQuery() {
  return queryOptions({
    queryKey: queryKeys.shell(),
    queryFn: () => loadAppShell(),
  });
}

// What the layout draws when it has no shell at all: the unreachable-API card,
// whose Retry re-runs the loader. Reachable only if the cache were empty, which
// the /app loader and the SSR payload between them rule out — but "we could not
// ask" is the honest answer to have here rather than a signed-out one, which
// would show the sign-in form to someone who is signed in.
const NO_ANSWER = { authed: false as const, apiDown: true as const };

export function useShell(): Shell {
  const { data = NO_ANSWER } = useQuery(shellQuery());
  return data;
}
