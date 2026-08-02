import { requiredEnv, trustsProxy } from "../env";
import { createAuth } from "./auth.config";
import { assertProductionUrl, useSecureCookies } from "./cookies";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3001";
// The dashboard's origin — where browser auth requests come from (via its BFF).
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";

assertProductionUrl(baseURL, process.env.NODE_ENV);

// Single configured auth instance for the app.
export const auth = createAuth({
  databaseUrl: requiredEnv("DATABASE_URL"),
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  baseURL,
  secureCookies: useSecureCookies(baseURL, process.env.NODE_ENV),
  trustedOrigins: [baseURL, webOrigin],
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
  trustProxy: trustsProxy(),
});
