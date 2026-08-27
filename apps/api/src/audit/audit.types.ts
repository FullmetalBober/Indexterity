import type { SecurityEventName } from "@repo/contracts";
import { SECURITY_EVENTS } from "@repo/contracts";
import type { ClusterEngine, TlsOverrides } from "../engine/ports";

// The trail's vocabulary: what may be recorded, and what each act records
// besides the columns every row has. Types and one re-export, so it is the file
// both providers in this directory and every caller of them can import without
// pulling a pool or a request in with it (#354).

// Who did what, to whom, from where — for the acts that are not index operations.
//
// `actions` covers the pipeline: every hide, drop, build and rollback, with its
// actor and its rollback token. This covers the rest of what an incident asks
// about, which had no trail at all (#53): sign-ins, the org's membership, and the
// four things that can be done to a cluster's access.

export type { SecurityEventName };
// The names moved to @repo/contracts when the trail got a screen (#158): the
// page labels rows and offers a kind filter from the same list this writes, and
// two copies of it would drift the moment an act is added. Re-exported so the
// call sites in this app keep importing it from here, beside the metadata
// shapes that only make sense next to it.
//
// The notes that used to sit inside the list, kept because they are about
// WRITING and belong here:
//
//   TWO_FACTOR_VERIFIED / _FAILED cover both moments a code is asked for —
//   completing a sign-in and proving an enrolment — because the path cannot
//   tell them apart and both are worth a row: a run of FAILED is someone
//   guessing at a code, whichever door they are guessing at.
//
//   TWO_FACTOR_OTP_SENT is the one second factor whose delivery leaves the
//   building, so a burst of them to one account is somebody working a password
//   they already have.
//
//   EMAIL_CHANGE_REQUESTED is the request and not the flip (#83): the flip
//   happens on a GET /verify-email link indistinguishable by path from ordinary
//   signup verification, and the request is the act with an actor behind it.
export { SECURITY_EVENTS };

// What each act records BESIDE the columns every row has, one entry per act that
// records anything. An act absent from here carries no specifics.
//
// The column is jsonb and was typed `Record<string, unknown>`, which is to say
// not typed: `{ readOnly }` and `{ readonly }` were equally acceptable, and the
// second reads back as an act with no mode in it. Nothing catches that later,
// because nothing READS these payloads — they are written for a person during an
// incident, so the first reader is the person who most needs them to be right,
// and by then the act is months old. This is the check that has to happen at the
// call site or nowhere (#24).
export interface SecurityEventMetadata {
  CLUSTER_CONNECTED: {
    engine: ClusterEngine;
    provisioned: boolean;
    // Only on the provisioned path — a user we created, so a name we can revoke.
    provisionedUsername?: string;
    tlsOverrides: TlsOverrides;
    // Which databases the cluster was connected to observe, or null for all of
    // them (#244) — the scope the credentials were accepted for, which on SQL
    // Server is also the scope the provisioned login was granted in.
    observedDatabases: string[] | null;
  };
  // `clusterId` here rather than in the column: the row it would point at is
  // deleted by the act this records.
  CLUSTER_DISCONNECTED: {
    clusterId: string;
    unhidden: number;
    provisionedUsername: string | null;
  };
  CLUSTER_CREDENTIALS_ROTATED: {
    provisionedUsername: string | null;
    keptScopedUser: boolean;
    tlsOverrides: TlsOverrides;
  };
  CLUSTER_MODE_CHANGED: { readOnly: boolean };
  // Both sides again, for the same reason the observe change records both: the
  // question an incident asks is what the rule WAS when a given cluster was
  // connected, and "requireLeastPrivilege: false" alone does not date the change
  // that made it false.
  ORG_POLICY_CHANGED: {
    from: { requireLeastPrivilege: boolean };
    to: { requireLeastPrivilege: boolean };
  };
  // Both sides of the change, because the interesting question in an incident is
  // what STOPPED being observed and when — "now watching app" does not answer it.
  // null on either side means every database the cluster has.
  CLUSTER_OBSERVED_DATABASES_CHANGED: {
    from: string[] | null;
    to: string[] | null;
    // Open proposals discarded because their database left the selection. A
    // number rather than the rows: the rows are gone, and how many were dropped is
    // the part that explains a recommendation count falling.
    discardedRecommendations: number;
  };
  // Which of better-auth's two revoke endpoints answered, since neither may
  // record the session token itself.
  SESSION_REVOKED: { scope: "one" | "others" };
  MEMBER_ROLE_CHANGED: { role: string | null };
  INVITE_CREATED: { role: string | null };
  // The gateway and what it was allowed to reach — never the config. The sealed
  // blob holds a PrivateKey, and this table is read by people who are not meant
  // to be able to bring the tunnel up, which is the same rule that keeps a
  // connection string out of CLUSTER_CONNECTED.
  //
  // `tunnelId` in the metadata because there is no column for it: a tunnel is an
  // org's, not a cluster's, and one row per cluster behind it would be three
  // rows for one act.
  TUNNEL_REGISTERED: {
    tunnelId: string;
    endpoint: string;
    allowedIps: string[];
    dns: string[];
  };
  // One nullable block per kind of change, so the row says WHICH of the two
  // happened rather than leaving a reader to diff two snapshots. A present
  // `config` is a replaced wg0.conf, which means a new PrivateKey as well as
  // whatever moved in the fields recorded here — and both sides of it, because
  // the question an incident asks is what this tunnel reached before.
  TUNNEL_UPDATED: {
    tunnelId: string;
    name: { from: string; to: string } | null;
    config: {
      from: { endpoint: string; allowedIps: string[]; dns: string[] };
      to: { endpoint: string; allowedIps: string[]; dns: string[] };
    } | null;
  };
  // Here rather than on the row for the reason CLUSTER_DISCONNECTED carries its
  // cluster id: the act deletes the thing a column would point at.
  TUNNEL_REMOVED: { tunnelId: string; endpoint: string; allowedIps: string[] };
}

interface SecurityEventColumns {
  readonly orgId?: string | null;
  readonly clusterId?: string | null;
  readonly actorUserId?: string | null;
  readonly actorEmail?: string | null;
  readonly target?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

// Distributed over the 23 names, so `event` decides what `metadata` may be: the
// shape above for an act that has one, and nothing at all for an act that does
// not. `metadata` stays optional on the acts that have a shape because
// auth-trail.ts builds one base object for every act and then fills in per case.
export type SecurityEventInput = {
  [K in SecurityEventName]: SecurityEventColumns & {
    readonly event: K;
  } & (K extends keyof SecurityEventMetadata
      ? { readonly metadata?: Readonly<SecurityEventMetadata[K]> | null }
      : { readonly metadata?: never });
}[SecurityEventName];

// The same event, minus the fields a caller with a request in hand does not
// supply — `actorFromRequest` fills those in. Distributive on purpose: a plain
// `Omit` over a union collapses it into one object whose `event` is every name
// and whose `metadata` is every shape, which is the type this file exists to
// stop existing.
export type SecurityEventDetails = SecurityEventInput extends infer T
  ? T extends SecurityEventInput
    ? Omit<T, "actorUserId" | "actorEmail" | "ipAddress" | "userAgent">
    : never
  : never;

// Who is making this request, in the shape `security_events` records.
//
// The address comes from Fastify's own resolution, which already honours
// TRUST_PROXY (env.ts) — so a deployment that has not said a proxy is in front
// records the proxy's address rather than inventing a client, and one that has
// records the client. The better-auth side of the trail reads the header itself
// (audit/security-events.ts) because it is handed a synthetic Request with no
// socket behind it.
//
// The email is read alongside the id and stored with the row. `actor_user_id` is
// `set null` on user deletion, and a trail whose actor column empties when the
// account is deleted answers none of the questions it exists for.
export interface RequestActor {
  readonly actorUserId: string;
  readonly actorEmail: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

// Everything better-auth serves, turned into rows in `security_events` (#53).
//
// An after-middleware rather than the database hooks, and that is the load-bearing
// choice here. `databaseHooks.session.create` would see a sign-in, and the
// organization plugin's `afterUpdateMemberRole` would see a promotion — but the
// plugin's hooks are handed the member, the target user and the org and NOT the
// caller. "Who promoted whom" is the question this table exists to answer, so a
// hook that cannot name the actor is not usable for it.
//
// The actor is passed in rather than read off the context, because the context
// does not carry one: `ctx.context.session` is empty in an after-hook even on
// routes that required a session, which the integration suite found by asserting
// that no row has a null actor — every org event was landing anonymous. The wiring
// resolves it with better-auth's own `getSessionFromCtx` and hands it here, and
// this module stays pure and testable.
//
// What is still not recorded here: a sign-out. By the time the after-hook runs the
// session row is gone, so nothing can be resolved from the request — that one is
// recorded from `databaseHooks.session.delete`, whose payload IS the session that
// ended (see sessionEndedEntry below).
//
// And what the shape costs: `previousRole` on a role change. Only the plugin hook
// is given it, so the row records the role the member now has and who gave it to
// them; the role before is the previous MEMBER_ROLE_CHANGED row for that target,
// which is what a trail is for.

export interface TrailActor {
  readonly userId: string;
  readonly email: string | null;
  // Which org the acting session was looking at — the fallback when neither the
  // request nor the response names one.
  readonly activeOrgId: string | null;
}

// The little of better-auth's hook context this reads, declared structurally so
// the mapping is testable with plain objects and a library upgrade that moves an
// unrelated field cannot break the build here for no reason.
export interface AuthHookContext {
  readonly path?: string;
  readonly body?: unknown;
  readonly headers?: Headers;
  readonly context: {
    readonly returned?: unknown;
  };
}
