// The four org-level reads: which clusters exist, the active org, the orgs the
// caller could switch to, and the invitations addressed to them.
//
// One query each, and none of them is "the shell". They used to be a single
// `shell` entry filled by one Promise.all, which read well until you noticed what
// it forced: the org page fetched a cluster list it never draws, and flipping a
// cluster to live invalidated the whole entry and so refetched the member list.
// Three requests were always three requests — the Promise.all only decided when
// they were awaited, and cached them as one answer.
//
// They run on the web server during SSR and in the browser afterwards, off the
// same isomorphic client (lib/api.ts).
import type { Cluster, MyInvite, OrgInfo, OrgSummary } from "@repo/contracts";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { isStatus } from "./errors";
import { queryKeys } from "./keys";

// Stable fallbacks — see the note in telemetry.ts.
export const NO_CLUSTERS: Cluster[] = [];
export const NO_ORGS: OrgSummary[] = [];
export const NO_INVITES: MyInvite[] = [];

export function clustersQuery() {
  return queryOptions({ queryKey: queryKeys.clusters(), queryFn: () => api().listClusters() });
}

export function orgQuery() {
  return queryOptions({ queryKey: queryKeys.org(), queryFn: () => api().getOrg() });
}

export function orgsQuery() {
  return queryOptions({ queryKey: queryKeys.orgs(), queryFn: () => api().listOrgs() });
}

export function myInvitesQuery() {
  return queryOptions({ queryKey: queryKeys.myInvites(), queryFn: () => api().listMyInvites() });
}

export function useClusters(): Cluster[] {
  const { data = NO_CLUSTERS } = useQuery(clustersQuery());
  return data;
}

// Null while it has not arrived, if the read failed, OR if the reader is in no
// organization — the api answers that last one with null rather than an error,
// because a create-org screen is not an error page. The layout above has already
// decided whether they are signed in at all, and draws the create screen itself
// when the org list is empty, so all three cases render nothing here.
export function useOrg(): OrgInfo | null {
  const { data = null } = useQuery(orgQuery());
  return data;
}

export function useOrgs(): OrgSummary[] {
  const { data = NO_ORGS } = useQuery(orgsQuery());
  return data;
}

export function useMyInvites(): MyInvite[] {
  const { data = NO_INVITES } = useQuery(myInvitesQuery());
  return data;
}

// What the /app layout needs in order to decide what to draw at all: signed in,
// signed out, or unable to ask. Derived over the three queries rather than kept as
// a fourth cache entry, because no endpoint answers it — it was always an
// inference from how the reads failed.
export type Shell =
  | {
      readonly authed: true;
      readonly clusters: Cluster[];
      readonly orgs: OrgSummary[];
      readonly invites: MyInvite[];
    }
  | { readonly authed: false; readonly apiDown: boolean };

// A failure is not an error to render. 401 means signed out and anything else
// means the api could not be asked — both are answers the layout knows how to
// draw. Any one of the three reporting 401 is enough: they go to the same api
// with the same cookie.
export function useShell(): Shell {
  const clusters = useQuery(clustersQuery());
  const org = useQuery(orgQuery());
  const orgs = useQuery(orgsQuery());
  const invites = useQuery(myInvitesQuery());

  const errors = [clusters.error, org.error, orgs.error, invites.error].filter(
    (error) => error !== null,
  );
  if (errors.some((error) => isStatus(error, 401))) return { authed: false, apiDown: false };
  if (errors.length > 0) return { authed: false, apiDown: true };

  // Still in flight with nothing cached. Reachable only if the cache were empty,
  // which the /app loader and the SSR payload between them rule out — but "we
  // could not ask" is the honest answer to have here rather than a signed-out
  // one, which would show the sign-in form to someone who is signed in.
  if (clusters.data === undefined || orgs.data === undefined || invites.data === undefined) {
    return { authed: false, apiDown: true };
  }

  // org.data is deliberately not required to be present: it is `null` for a
  // reader who belongs to no organization, which is a signed-in state and the
  // one the create-org screen exists for.
  return { authed: true, clusters: clusters.data, orgs: orgs.data, invites: invites.data };
}

// What the layout's Retry button does when the api could not be reached. It lives
// here rather than in the route because the set of keys behind the unreachable
// card is this file's business — the route should not have to know there are
// four. Refetching is also the only thing that retries: re-running the loader
// would call ensureQueryData, and the button would look like a button and do
// nothing until a full page reload.
export async function refetchShell(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.clusters() }),
    client.invalidateQueries({ queryKey: queryKeys.org() }),
    client.invalidateQueries({ queryKey: queryKeys.orgs() }),
    client.invalidateQueries({ queryKey: queryKeys.myInvites() }),
  ]);
}

// Which cluster a page is about. The cluster list says what exists, the URL says
// which one is selected, and "none selected" means the first. Defined once so the
// cluster bar and the dashboard's cache keys cannot disagree — they did, and one
// entry then held two different clusters' answers.
export function selectCluster<T extends { readonly id: string }>(
  clusters: readonly T[],
  selected: string | null | undefined,
): T | null {
  return clusters.find((entry) => entry.id === selected) ?? clusters[0] ?? null;
}
