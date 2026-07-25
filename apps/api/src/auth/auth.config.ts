import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDatabase, schema } from "../db";

export interface AuthConfig {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseURL: string;
  readonly githubClientId: string;
  readonly githubClientSecret: string;
}

// GitHub OAuth + email/password, backed by the Drizzle/Postgres control-plane DB.
export function createAuth(config: AuthConfig) {
  const db = createDatabase(config.databaseUrl);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret: config.secret,
    baseURL: config.baseURL,
    emailAndPassword: { enabled: true },
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
