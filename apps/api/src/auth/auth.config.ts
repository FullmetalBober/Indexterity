import { PASSWORD_MIN_LENGTH } from "@repo/contracts";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { createDatabase, schema } from "../db";
import { sendMail } from "../mail/mailer";
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
}

// GitHub OAuth + email/password, backed by the Drizzle/Postgres control-plane DB.
export function createAuth(config: AuthConfig) {
  const db = createDatabase(config.databaseUrl);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [...config.trustedOrigins],
    // SameSite=Lax (better-auth's default) is what stops cross-site mutations;
    // this is what keeps the cookie off plaintext.
    advanced: {
      useSecureCookies: config.secureCookies,
      // Only when the deployment says a proxy is in front. Reading a forwarded
      // header otherwise lets a client pick its own address and never reach a
      // rate limit.
      ...(config.trustProxy ? { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } } : {}),
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
