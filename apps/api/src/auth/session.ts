import { ORPCError } from "@orpc/server";
import type { FastifyRequest } from "fastify";
import { field } from "../errors/message";
import { auth } from ".";
import { toWebHeaders } from "./http";

export interface CallerSession {
  readonly userId: string;
  // Which org this session switched to, from the organization plugin. Null on a
  // session that has never switched, or whose org was deleted underneath it —
  // both fall back to the caller's oldest membership (auth/tenancy.ts).
  readonly activeOrgId: string | null;
  // When the caller last SIGNED IN — the session row's createdAt, which the
  // rolling refresh (updateAge) never touches. Re-authenticating mints a new
  // row, so this is what "a fresh session" is measured from
  // (TenancyService.requireFreshOwner, #52).
  readonly signedInAt: Date;
  // The twoFactor plugin's flag on the user: a code has verified at least
  // once. What requireOwner checks when the deployment demands a second
  // factor of owners (#55). False for a cookie signed before the plugin
  // existed; those age out with the cache.
  readonly twoFactorEnabled: boolean;
}

// One `auth.api.getSession` per request. Several endpoints used to ask more
// than once — the handler for the org, guardDial for the user id — and every
// ask was its own round trip (#77). The request is the cache boundary: the
// caller cannot change mid-request, so the first resolution answers them all,
// including concurrent ones, which share the promise rather than the result.
// Keyed on the port, not on FastifyRequest: identity is what the cache is
// about, and the port is what every function here now takes.
const resolvedByRequest = new WeakMap<RequestHeaders, Promise<CallerSession | null>>();
// Cookies better-auth asked to set while resolving — the refreshed session
// cache (auth.config.ts). Stashed beside the resolution, not inside it, so the
// onSend hook can read them without awaiting anything: by the time a response
// is being sent, every resolution the handler awaited has settled.
const setCookiesByRequest = new WeakMap<RequestHeaders, readonly string[]>();

function resolveSession(req: RequestHeaders): Promise<CallerSession | null> {
  const pending = resolvedByRequest.get(req);
  if (pending !== undefined) return pending;
  const fresh = auth.api
    .getSession({ headers: toWebHeaders(req.headers), returnHeaders: true })
    .then(({ headers, response }) => {
      const setCookies = headers.getSetCookie();
      if (setCookies.length > 0) setCookiesByRequest.set(req, setCookies);
      return response === null
        ? null
        : {
            userId: response.user.id,
            activeOrgId: response.session.activeOrganizationId ?? null,
            // A Date from postgres, an ISO string when the cookie cache
            // answered — the constructor takes both.
            signedInAt: new Date(response.session.createdAt),
            twoFactorEnabled: field(response.user, "twoFactorEnabled") === true,
          };
    });
  resolvedByRequest.set(req, fresh);
  return fresh;
}

// The set-cookie headers the resolution produced, for main.ts to forward onto
// the response — dropped instead, the session cache would expire shortly after
// sign-in and never come back, because the dashboard's steady traffic is oRPC
// calls, not better-auth routes. Empty when nothing asked for the session, or
// when resolving it failed (that failure already failed the request itself).
// Synchronous on purpose: an async onSend hook holds the send open and races
// any handler that called reply.send() without returning the reply.
/**
 * What this module reads of a request: its headers.
 *
 * A real `FastifyRequest` satisfies it, so nothing at a call site changes — and
 * a test writes the one member instead of asserting a whole request onto an
 * object with a cookie in it.
 */
export interface RequestHeaders {
  readonly headers: FastifyRequest["headers"];
}

export function sessionCookiesFor(req: RequestHeaders): readonly string[] {
  return setCookiesByRequest.get(req) ?? [];
}

// Authn: the caller's session, or 401. Tenancy scoping is layered on top.
export async function requireSession(req: RequestHeaders): Promise<CallerSession> {
  const session = await resolveSession(req);
  if (session === null) throw new ORPCError("UNAUTHORIZED", { message: "sign in required" });
  return session;
}

export async function requireUserId(req: RequestHeaders): Promise<string> {
  return (await requireSession(req)).userId;
}
