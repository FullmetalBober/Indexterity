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
import type { Cluster, MyInvite, OrgInfo, OrgSummary, SupportedEngine } from "@repo/contracts";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { isStatus, statusOf } from "./errors";
import { queryKeys } from "./keys";

// Stable fallbacks — see the note in telemetry.ts.
export const NO_CLUSTERS: Cluster[] = [];
export const NO_ORGS: OrgSummary[] = [];
export const NO_INVITES: MyInvite[] = [];
export const NO_ENGINES: SupportedEngine[] = [];

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

// What this build can connect, for the connect form's helper text and its engine
// override (#239). `staleTime: Infinity` because the answer is a property of the
// deployed api: it changes when the api is replaced, which replaces this tab's
// session too, and re-asking on every mount would be a request per visit to the
// page for an answer that cannot have moved.
export function enginesQuery() {
  return queryOptions({
    queryKey: queryKeys.engines(),
    queryFn: () => api().listSupportedEngines(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useClusters(): Cluster[] {
  const { data = NO_CLUSTERS } = useQuery(clustersQuery());
  return data;
}

// Empty while it has not arrived, and the form draws nothing engine-specific in
// that window rather than a guess: an empty list is "we have not been told yet",
// which for one render is invisible, while a hardcoded fallback sentence would
// be a claim about a build it never asked.
export function useEngines(): SupportedEngine[] {
  const { data = NO_ENGINES } = useQuery(enginesQuery());
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
// signed out, still finding out, or unable to ask. Derived over the four
// queries rather than kept as a fifth cache entry, because no endpoint answers
// it — it was always an inference from how the reads failed, or hadn't
// answered yet.
//
// What the api actually said, when it said anything. `status` is null for a
// request that got no response at all (DNS, refused, timed out) — the one case
// "unreachable" is literally true for — and a number when the api was reached
// and answered with something other than 401. A 500 is not the same failure as
// a dropped connection, and the layout draws them differently (#183 follow-up:
// the card used to say "unreachable" for both).
export interface ApiFailure {
  readonly status: number | null;
}

export type Shell =
  | {
      readonly authed: true;
      readonly clusters: Cluster[];
      readonly orgs: OrgSummary[];
      readonly invites: MyInvite[];
    }
  | { readonly authed: false; readonly state: "signed-out" }
  // Genuinely still in flight, nothing cached yet, nothing wrong — the /app
  // loader's ensureQueryData had not settled by the time this rendered. Found
  // live, not assumed: a cold SSR render of a deep-linked child route (e.g.
  // /app/clusters/:id, hit with no session at all) can render before the
  // loader's Promise.allSettled has actually populated the cache this hook
  // reads, so every one of the four sits at `status: "pending"` here — no
  // error, because nothing has answered yet either way. THIS branch is what a
  // reader saw as "The API is unreachable right now", for a beat, before the
  // real answer (usually the sign-in form) replaced it. It was folded into
  // `apiDown` before, which is why a loading state and a real outage looked
  // identical; kept separate now so the layout can draw neither as a failure.
  | { readonly authed: false; readonly state: "loading" }
  | { readonly authed: false; readonly state: "down"; readonly failure: ApiFailure };

// A failure is not an error to render. 401 means signed out and anything else
// means the api could not be asked as intended — both are answers the layout
// knows how to draw. Any one of the four reporting 401 is enough: they go to
// the same api with the same cookie.
export function useShell(): Shell {
  const clusters = useQuery(clustersQuery());
  const org = useQuery(orgQuery());
  const orgs = useQuery(orgsQuery());
  const invites = useQuery(myInvitesQuery());

  const errors = [clusters.error, org.error, orgs.error, invites.error].filter(
    (error) => error !== null,
  );
  if (errors.some((error) => isStatus(error, 401))) return { authed: false, state: "signed-out" };
  if (errors.length > 0) {
    return { authed: false, state: "down", failure: describeFailure(errors) };
  }

  // Still in flight with nothing cached, and no error either — a fetch that
  // has not settled is not a failure, and must not be drawn as one.
  if (clusters.data === undefined || orgs.data === undefined || invites.data === undefined) {
    return { authed: false, state: "loading" };
  }

  // org.data is deliberately not required to be present: it is `null` for a
  // reader who belongs to no organization, which is a signed-in state and the
  // one the create-org screen exists for.
  return { authed: true, clusters: clusters.data, orgs: orgs.data, invites: invites.data };
}

// Any one of the four having a real status beats all of them having none: a
// status means the api was reached, which is a narrower, more specific problem
// than nothing answering at all — and worth surfacing over the less informative
// shape if both are present.
function describeFailure(errors: readonly unknown[]): ApiFailure {
  for (const error of errors) {
    const status = statusOf(error);
    if (status !== null) return { status };
  }
  return { status: null };
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

// The cluster a page is about, out of the live list.
//
// There used to be a `selectCluster(clusters, selected)` here whose whole job
// was resolving "none selected" to the first cluster, because the selection was
// a search param that could be absent. It could also name a cluster the reader
// no longer owns, which is how one cache entry ended up holding two clusters'
// answers (#82). A cluster is a route now: /app resolves "none selected" once,
// by redirecting, and everything below it is handed a concrete id.
//
// Null means the list has not arrived, failed, or no longer contains this id.
// The last of those is a frame long — the route's loader redirects on it.
export function useCluster(clusterId: string): Cluster | null {
  const clusters = useClusters();
  return clusters.find((entry) => entry.id === clusterId) ?? null;
}
