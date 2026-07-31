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
  // Origins allowed to make auth requests (CSRF); include the web app's origin.
  readonly trustedOrigins: readonly string[];
  readonly githubClientId: string;
  readonly githubClientSecret: string;
  // When true, unverified accounts cannot sign in (production posture). Off by
  // default so dev/test environments work without SMTP.
  readonly requireEmailVerification: boolean;
}

// GitHub OAuth + email/password, backed by the Drizzle/Postgres control-plane DB.
export function createAuth(config: AuthConfig) {
  const db = createDatabase(config.databaseUrl);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [...config.trustedOrigins],
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
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export { toNodeHandler } from "better-auth/node";
