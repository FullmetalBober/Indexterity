import { requiredEnv } from "../env";
import { createAuth } from "./auth.config";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3001";
// The dashboard's origin — where browser auth requests come from (via its BFF).
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";

// Single configured auth instance for the app.
export const auth = createAuth({
  databaseUrl: requiredEnv("DATABASE_URL"),
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  baseURL,
  trustedOrigins: [baseURL, webOrigin],
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
});
