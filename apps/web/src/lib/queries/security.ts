// The organization's security trail (#158).
//
// Its own module rather than a fifth entry in shell.ts: those four are read by
// every signed-in view and warmed by the /app layout, and this one is read by
// exactly one page, by owners only, and is paged. Putting it beside them would
// make the shell's loader look like it should warm this too.
import type { SecurityTrail } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { isStatus } from "./errors";
import { queryKeys } from "./keys";

export interface TrailFilter {
  readonly event?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly beforeCreatedAt?: string | undefined;
  readonly beforeId?: string | undefined;
}

// A cluster with nothing recorded and a read that failed both draw an empty
// trail, which is honest either way: neither is evidence that nothing happened.
export const NO_TRAIL: SecurityTrail = {
  events: [],
  total: 0,
  nextCreatedAt: null,
  nextId: null,
};

export function securityEventsQuery(filter: TrailFilter) {
  return queryOptions({
    queryKey: queryKeys.securityEvents(filter),
    // The filter is spread rather than passed whole so an undefined field is
    // absent from the query string rather than the string "undefined".
    queryFn: () =>
      api().listSecurityEvents({
        ...(filter.event === undefined ? {} : { event: filter.event }),
        ...(filter.actorUserId === undefined ? {} : { actorUserId: filter.actorUserId }),
        // Both halves or neither: a cursor that is only a timestamp would skip a
        // row sharing the microsecond, so the api takes them as a pair.
        ...(filter.beforeCreatedAt === undefined || filter.beforeId === undefined
          ? {}
          : { beforeCreatedAt: filter.beforeCreatedAt, beforeId: filter.beforeId }),
      }),
    // Kept while the reader pages back and forth. The trail is append-only, so a
    // page of it does not go stale the way a cluster's numbers do — only the
    // first page ever gains rows.
    staleTime: 30_000,
    // A member reading this gets a 403, and no amount of retrying changes which
    // role they hold. Retried, it would be three refusals per navigation.
    retry: (_count: number, error: unknown) => !isStatus(error, 403),
  });
}

export function useSecurityEvents(filter: TrailFilter): {
  data: SecurityTrail;
  pending: boolean;
  // The refusal has to reach the page. This is the one read in the product that
  // a signed-in member of the org may not make, and folding a 403 into the empty
  // fallback would tell them the trail is empty — a claim about the
  // organization, made because of a permission they do not have.
  forbidden: boolean;
} {
  const { data = NO_TRAIL, isPending, error } = useQuery(securityEventsQuery(filter));
  return { data, pending: isPending, forbidden: isStatus(error, 403) };
}
