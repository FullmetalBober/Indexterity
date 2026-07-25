import { requiredEnv } from "../env";
import { createAuth } from "./auth.config";

// Single configured auth instance for the app (and the dev sign-up demo).
export const auth = createAuth({
  databaseUrl: requiredEnv("DATABASE_URL"),
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
});
