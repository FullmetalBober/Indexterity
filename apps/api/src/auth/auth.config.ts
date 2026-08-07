import { randomUUID } from "node:crypto";
import { PASSWORD_MIN_LENGTH } from "@repo/contracts";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
import { authTrailEntry, sessionEndedEntry, type TrailActor } from "../audit/auth-trail";
import { authEventFor, recordSecurityEvent } from "../audit/security-events";
import { createDatabase, eq, schema, user as userTable } from "../db";
import { sendMail } from "../mail/mailer";
import { organizationPlugin } from "./organization";
import { authRateLimit } from "./rate-limit";
import { evaluateSignup } from "./signup-gate";

export interface AuthConfig {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseURL: string;
  // Set `Secure` on the session cookie. Decided explicitly rather than inferred
  // from the baseURL scheme — see auth/cookies.ts.
  readonly secureCookies: boolean;
  // Origins allowed to make auth requests (CSRF); include the web app's origin.
  readonly trustedOrigins: readonly string[];
  readonly githubClientId: string;
  readonly githubClientSecret: string;
  // When true, unverified accounts cannot sign in (production posture). Off by
  // default so dev/test environments work without SMTP.
  readonly requireEmailVerification: boolean;
  // A trusted proxy sits in front, so forwarded client addresses are real.
  readonly trustProxy: boolean;
  // Which forwarded hops to distrust, as IPs or CIDR ranges. Empty means a
  // forwarded header is only believed when it carries exactly one address —
  // better-auth's rule, and the reason a multi-hop ingress collapses every client
  // into one rate-limit bucket (see env.ts, and auth/rate-limit.ts).
  readonly trustedProxies: readonly string[];
  // Attempts a minute allowed on the credential endpoints, per client address.
  // The same AUTH_RATE_LIMIT_MAX the Fastify limiter reads, so tuning it moves the
  // limit that actually applies rather than only the one that does not (#54).
  readonly authRateLimitMax: number;
  // The dashboard's origin, for the link in an invitation email.
  readonly webOrigin: string;
}

// Who is making this request, for the security trail. Two sources, because the
// acts arrive in two shapes and neither covers the other — both measured against
// the integration suite rather than reasoned about:
//
//   A sign-in or sign-up has NO session in the request. Its cookie is in the
//   response, and the session it just created is on `context.newSession`.
//
//   An org act arrives WITH a session and no new one. `ctx.context.session` is
//   empty in an after-hook even on routes that required one, so it has to be
//   resolved — `getSessionFromCtx` is better-auth's own resolver, the one its
//   `sessionMiddleware` uses, so this reads exactly what the endpoint was
//   authorised against, cookie cache included.
//
// Reading only the second made every org event anonymous; reading only the first
// made every sign-in anonymous. The suite caught each by asserting that no row has
// a null actor.
//
// Null is still a normal answer: a failed sign-in has nobody behind it.
async function trailActor(
  ctx: Parameters<typeof getSessionFromCtx>[0] & {
    context: {
      newSession?: { session: Record<string, unknown>; user: Record<string, unknown> } | null;
    };
  },
): Promise<TrailActor | null> {
  const fresh = ctx.context.newSession;
  if (fresh !== null && fresh !== undefined) return asActor(fresh.user, fresh.session);
  try {
    const resolved = await getSessionFromCtx(ctx);
    return resolved === null ? null : asActor(resolved.user, resolved.session);
  } catch {
    // Resolving the actor must not fail the act. A row that says it does not know
    // who did something is worse than one that names them, and both are better
    // than a 500 on a sign-in.
    return null;
  }
}

function asActor(
  user: Record<string, unknown>,
  session: Record<string, unknown>,
): TrailActor | null {
  const userId = user.id;
  if (typeof userId !== "string") return null;
  return {
    userId,
    email: typeof user.email === "string" ? user.email : null,
    activeOrgId:
      typeof session.activeOrganizationId === "string" ? session.activeOrganizationId : null,
  };
}

// GitHub OAuth + email/password, backed by the Drizzle/Postgres control-plane DB.
export function createAuth(config: AuthConfig) {
  const db = createDatabase(config.databaseUrl);
  // The email is stored alongside the id on every row (`actor_email`), because
  // `actor_user_id` is `set null` on user deletion and a trail whose actor column
  // empties when the account goes answers none of the questions it exists for.
  const emailOf = async (userId: string): Promise<string | null> => {
    const [row] = await db
      .select({ email: userTable.email })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    return row?.email ?? null;
  };
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [...config.trustedOrigins],
    session: {
      // The session rides a second, short-lived HMAC-signed cookie, so the
      // common request decides who is asking without touching postgres.
      // Freshness is not lost where it matters: membership and role are read
      // from `members` on every request regardless (auth/tenancy.ts), and a
      // session change invalidates the cookie in the same response — set-active
      // re-signs it, everything else goes through the hooks.after below. The
      // onSend hook in main.ts is what keeps the cache warm in between: it
      // forwards the re-armed cookie whenever resolving a request had to fall
      // through to postgres.
      //
      // The trade is revocation: a session revoked server-side keeps answering
      // for up to maxAge on a browser that still holds the cookie. Sign-out is
      // not that case — better-auth clears both session cookies in the same
      // response — so five minutes buys the round trip back on nearly every
      // request and is only ever stale for a session torn down behind the
      // browser's back, which nothing here does today.
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },
    // SameSite=Lax (better-auth's default) is what stops cross-site mutations;
    // this is what keeps the cookie off plaintext.
    advanced: {
      useSecureCookies: config.secureCookies,
      // Every id this deployment mints is a UUID, including better-auth's own.
      //
      // The organization plugin's tables ARE our tenancy tables, whose keys are
      // `uuid` and are referenced by a cascading `org_id` on three others; the
      // alternative was retyping that key and every `z.uuid()` in the contracts
      // while live rows pointed at it. Handing better-auth a generator costs one
      // line and makes user/session/account ids uuids too, which is harmless —
      // those columns are text, and existing rows keep the ids they have.
      //
      // A function rather than the built-in `"uuid"` setting, which means
      // something else: it tells the adapter the DATABASE will generate the id,
      // and `user`, `session`, `account` and `verification` have text keys with
      // no default to generate one.
      database: { generateId: () => randomUUID() },
      // Only when the deployment says a proxy is in front. Reading a forwarded
      // header otherwise lets a client pick its own address and never reach a
      // rate limit.
      //
      // `trustedProxies` is what makes the header usable behind a real ingress:
      // without it better-auth believes X-Forwarded-For only when it holds a
      // single address, and an ingress adds itself as a second hop — so every
      // client resolved to "no trusted ip" and shared one bucket. With the list it
      // walks the chain from the right and stops at the first hop we did not name.
      ...(config.trustProxy
        ? {
            ipAddress: {
              ipAddressHeaders: ["x-forwarded-for"],
              ...(config.trustedProxies.length > 0
                ? { trustedProxies: [...config.trustedProxies] }
                : {}),
            },
          }
        : {}),
    },
    // Counted in Postgres, so the limit is the deployment's rather than each
    // pod's, and the configured number is the one that applies to a sign-in.
    // See auth/rate-limit.ts for what is left at better-auth's defaults and why.
    rateLimit: authRateLimit(config.authRateLimitMax),
    plugins: [
      organizationPlugin(db, {
        webOrigin: config.webOrigin,
        requireEmailVerification: config.requireEmailVerification,
      }),
    ],
    // The cookie cache must not outlive a session row it disagrees with. Only
    // set-active re-signs the cookie itself; organization.create, delete and
    // accept-invitation change the row's activeOrganizationId WITHOUT
    // re-signing — the plugin's adapter stops at `updateSession`, which never
    // sees the request, so neither it nor a database hook can reach the
    // response's cookies. Measured, not assumed: with only cookieCache
    // enabled, invite-member 400s ORGANIZATION_NOT_FOUND right after creating
    // an org (the cached null shadows the row), and an accepted invitee stays
    // scoped to their old org for maxAge (the cached id names an org they are
    // genuinely in, so nothing falls through).
    //
    // By behaviour rather than by route name, so a plugin upgrade cannot
    // reopen the gap: after any organization mutation, if the response is not
    // already carrying a re-signed cache cookie, expire it. The caller's next
    // request falls through to postgres and the onSend hook in main.ts re-arms
    // the cache with what the row now says. On routes that did not touch the
    // session this costs that caller one extra read; on set-active, the fresh
    // cookie is already in the response and is kept.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        // The security trail (audit/auth-trail.ts). First, and never allowed to
        // throw: whether the act is recorded must not decide whether it happened,
        // and a lost row is logged rather than escalated.
        //
        // Here rather than in databaseHooks because this is the only place the
        // ACTOR can be established. `session.create` sees a sign-in and the
        // organization plugin's after-hooks see a promotion, but the plugin is
        // handed the member and the org and not the caller — and "who promoted
        // whom" is the question (#53).
        //
        // The path is classified BEFORE the actor is resolved, and that ordering
        // is the point: resolving one costs a session lookup, and most traffic
        // through here is `/get-session` on ordinary navigation, which records
        // nothing. Only the dozen-odd acts pay for it.
        if (authEventFor(ctx.path, !(ctx.context.returned instanceof Error)) !== null) {
          const entry = authTrailEntry(ctx, await trailActor(ctx), config.trustProxy);
          if (entry !== null) {
            await recordSecurityEvent(db, entry, (message) => ctx.context.logger.warn(message));
          }
        }
        if (ctx.method !== "POST" || !ctx.path.startsWith("/organization/")) return;
        const sessionData = ctx.context.authCookies.sessionData;
        const pending = ctx.context.responseHeaders?.getSetCookie() ?? [];
        const reSigned = pending.some((cookie) => cookie.startsWith(`${sessionData.name}=`));
        if (!reSigned) expireCookie(ctx, sessionData);
      }),
    },
    databaseHooks: {
      session: {
        delete: {
          // The one act the after-middleware cannot record: signing out destroys
          // the session it would have to resolve the actor from, so the trail
          // would say somebody signed out and not who (#53). The row being
          // deleted IS the answer.
          //
          // Only a sign-out. Revocations delete sessions too and are recorded by
          // the middleware instead, where the revoker's own session is intact —
          // and revoking in bulk does not come through here row by row anyway.
          // A delete with no request behind it (expiry cleanup, a cascade) is not
          // an act and gets nothing.
          after: async (endedSession, context) => {
            const userId = endedSession.userId;
            const entry = sessionEndedEntry({
              path: context?.path ?? null,
              actor:
                typeof userId === "string"
                  ? {
                      userId,
                      email: await emailOf(userId),
                      activeOrgId:
                        typeof endedSession.activeOrganizationId === "string"
                          ? endedSession.activeOrganizationId
                          : null,
                    }
                  : null,
              headers: context?.headers,
              trustProxy: config.trustProxy,
            });
            if (entry === null) return;
            await recordSecurityEvent(db, entry, (message) =>
              context?.context.logger.warn(message),
            );
          },
        },
      },
      user: {
        create: {
          // Gates account creation for BOTH email/password and OAuth — the
          // control plane dials customer networks, so an open front door is
          // not a neutral default (SIGNUP_MODE, see auth/signup-gate.ts).
          before: async (newUser) => {
            const decision = await evaluateSignup(db, newUser.email);
            if (!decision.allowed) {
              throw new APIError("FORBIDDEN", { message: decision.reason });
            }
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Stated rather than left to better-auth's default (the same 8) because
      // the sign-up form validates against this exact constant — see
      // @repo/contracts inputs.ts. A default is not a shared rule.
      minPasswordLength: PASSWORD_MIN_LENGTH,
      requireEmailVerification: config.requireEmailVerification,
      sendResetPassword: async ({ user, url }) => {
        await sendMail(
          user.email,
          "Reset your Indexterity password",
          `Someone (hopefully you) asked to reset the password for ${user.email}.\n\n` +
            `Reset it here:\n${url}\n\nIf this wasn't you, ignore this email — ` +
            `nothing changes until the link is used.`,
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(
          user.email,
          "Verify your email for Indexterity",
          `Welcome to Indexterity!\n\nConfirm this address:\n${url}\n\n` +
            `If you didn't create an account, ignore this email.`,
        );
      },
    },
    // Registered only when configured. better-auth warns on every boot about a
    // provider with empty credentials, and a warning nobody can act on trains
    // people to ignore the log.
    ...(config.githubClientId && config.githubClientSecret
      ? {
          socialProviders: {
            github: {
              clientId: config.githubClientId,
              clientSecret: config.githubClientSecret,
            },
          },
        }
      : {}),
  });
}

export type Auth = ReturnType<typeof createAuth>;

export { toNodeHandler } from "better-auth/node";
