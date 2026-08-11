import {
  authEventFor,
  clientFromHeaders,
  type SecurityEventInput,
  type SecurityEventName,
} from "./security-events";

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

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

function text(value: unknown, key: string): string | null {
  const found = field(value, key);
  return typeof found === "string" && found !== "" ? found : null;
}

// The org the act belongs to: what the caller named, else what the endpoint
// answered with, else whichever org the acting session was looking at.
function orgOf(ctx: AuthHookContext, actor: TrailActor | null): string | null {
  const returned = ctx.context.returned;
  return (
    text(ctx.body, "organizationId") ??
    text(returned, "organizationId") ??
    text(field(returned, "invitation"), "organizationId") ??
    text(field(returned, "member"), "organizationId") ??
    (ctx.path === "/organization/create" ? text(returned, "id") : null) ??
    actor?.activeOrgId ??
    null
  );
}

// Turned into a row, or null when the request was not one of the acts. Pure: the
// database, the clock and the insert are all somebody else's.
export function authTrailEntry(
  ctx: AuthHookContext,
  actor: TrailActor | null,
  trustProxy: boolean,
): SecurityEventInput | null {
  const path = ctx.path;
  if (path === undefined) return null;
  // An APIError is an Error, so this covers every refusal without depending on
  // better-auth's error class: a 403 on someone else's invitation, a rejected
  // password, a plan limit.
  const ok = !(ctx.context.returned instanceof Error);
  const event = authEventFor(path, ok);
  if (event === null) return null;
  // Recorded from the session that ended, not from the request. See
  // sessionEndedEntry.
  if (event === "SIGN_OUT") return null;

  const base = {
    event,
    orgId: orgOf(ctx, actor),
    actorUserId: actor?.userId ?? null,
    actorEmail: actor?.email ?? null,
    ...clientFromHeaders(ctx.headers, trustProxy),
  } satisfies SecurityEventInput;

  switch (event) {
    // Nobody proved who they were, so the address goes in `target` rather than in
    // `actor`: it is what was claimed, not who acted.
    case "SIGN_IN_FAILED":
      return {
        ...base,
        orgId: null,
        actorUserId: null,
        actorEmail: null,
        target: text(ctx.body, "email"),
      };
    // Deliberately no target. `/revoke-session` identifies the session by its
    // token, and a token is a live credential — an audit table is the last place
    // it should be copied to. Which session it was is recoverable from the
    // sign-in rows and the time; the credential is not worth storing to save that.
    case "SESSION_REVOKED":
      return { ...base, metadata: { scope: path === "/revoke-session" ? "one" : "others" } };
    case "MEMBER_ROLE_CHANGED":
      return {
        ...base,
        target:
          text(field(ctx.context.returned, "user"), "email") ??
          text(ctx.body, "memberId") ??
          text(ctx.body, "memberIdOrEmail"),
        metadata: { role: text(ctx.body, "role") },
      };
    case "MEMBER_REMOVED":
      return { ...base, target: text(ctx.body, "memberIdOrEmail") };
    case "MEMBER_LEFT":
      return { ...base, target: actor?.email ?? null };
    case "INVITE_CREATED":
      return {
        ...base,
        target: text(ctx.body, "email"),
        metadata: { role: text(ctx.body, "role") },
      };
    // Accepted by the invited person, so actor and target are the same address —
    // said twice on purpose, because the interesting fact is that this account
    // gained a membership, and a reader scanning the target column should see it.
    case "INVITE_ACCEPTED":
      return { ...base, target: actor?.email ?? null };
    case "ORG_CREATED":
      return { ...base, target: text(ctx.context.returned, "name") };
    case "ORG_DELETED":
      return { ...base, target: text(ctx.body, "organizationId") };
    default:
      return base;
  }
}

// A session that has just been deleted, from `databaseHooks.session.delete`.
//
// This is the only place a sign-out can be recorded with an actor: the row being
// deleted carries the user, and by the time any after-middleware runs there is no
// session left to resolve from the request. Revocations are NOT recorded here even
// though they also delete sessions — the middleware sees those with the revoker's
// own session intact, and revoking in bulk does not delete row by row.
//
// `path` null means nothing was requested: expiry cleanup, a cascade, a script.
// Those are not acts and get no row.
export function sessionEndedEntry(input: {
  readonly path: string | null | undefined;
  readonly actor: TrailActor | null;
  readonly headers: Headers | undefined;
  readonly trustProxy: boolean;
}): SecurityEventInput | null {
  if (input.path !== "/sign-out") return null;
  const event: SecurityEventName = "SIGN_OUT";
  return {
    event,
    orgId: input.actor?.activeOrgId ?? null,
    actorUserId: input.actor?.userId ?? null,
    actorEmail: input.actor?.email ?? null,
    ...clientFromHeaders(input.headers, input.trustProxy),
  };
}
