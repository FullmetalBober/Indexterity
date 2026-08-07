import { positiveEnv, requiredEnv, trustedProxyCidrs, trustsProxy } from "../env";
import { createAuth } from "./auth.config";
import { assertProductionUrl, useSecureCookies } from "./cookies";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3001";
// The dashboard's origin — where browser auth requests come from. Since the api
// answers under /api on that same origin, this is usually BETTER_AUTH_URL again;
// it stays a separate variable because trustedOrigins is the thing that decides
// which Origin header and which redirect target are acceptable, and that is
// worth being able to state without inferring it.
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
  trustedProxies: trustedProxyCidrs(),
  // The same variable main.ts hands @fastify/rate-limit, and the same unit
  // (attempts a minute). One knob, two limiters, and now the tighter of the two
  // reads it too — see auth/rate-limit.ts.
  authRateLimitMax: positiveEnv("AUTH_RATE_LIMIT_MAX", 20),
  webOrigin,
});
