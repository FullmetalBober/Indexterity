import { randomUUID } from "node:crypto";
import { PASSWORD_MIN_LENGTH } from "@repo/contracts";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
import { createDatabase, schema } from "../db";
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

// GitHub OAuth + email/password, backed by the Drizzle/Postgres control-plane DB.
export function createAuth(config: AuthConfig) {
  const db = createDatabase(config.databaseUrl);
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
        if (ctx.method !== "POST" || !ctx.path.startsWith("/organization/")) return;
        const sessionData = ctx.context.authCookies.sessionData;
        const pending = ctx.context.responseHeaders?.getSetCookie() ?? [];
        const reSigned = pending.some((cookie) => cookie.startsWith(`${sessionData.name}=`));
        if (!reSigned) expireCookie(ctx, sessionData);
      }),
    },
    databaseHooks: {
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
