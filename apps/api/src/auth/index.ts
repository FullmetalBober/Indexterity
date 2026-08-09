import { apiEnv, requireOwnerTwoFactor, trustedProxyCidrs, trustsProxy } from "../config/env";
import { createAuth } from "./auth.config";
import { assertProductionUrl, useSecureCookies } from "./cookies";

const env = apiEnv();
const baseURL = env.BETTER_AUTH_URL;
// The dashboard's origin — where browser auth requests come from. Since the api
// answers under /api on that same origin, this is usually BETTER_AUTH_URL again;
// it stays a separate variable because trustedOrigins is the thing that decides
// which Origin header and which redirect target are acceptable, and that is
// worth being able to state without inferring it.
const webOrigin = env.WEB_ORIGIN;

assertProductionUrl(baseURL, env.NODE_ENV, env.ALLOW_INSECURE_AUTH_URL);

// Single configured auth instance for the app.
export const auth = createAuth({
  databaseUrl: env.DATABASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  baseURL,
  secureCookies: useSecureCookies(baseURL, env.NODE_ENV),
  trustedOrigins: [baseURL, webOrigin],
  githubClientId: env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: env.GITHUB_CLIENT_SECRET ?? "",
  requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION,
  trustProxy: trustsProxy(),
  trustedProxies: trustedProxyCidrs(),
  // The same variable main.ts hands @fastify/rate-limit, and the same unit
  // (attempts a minute). One knob, two limiters, and now the tighter of the two
  // reads it too — see auth/rate-limit.ts.
  authRateLimitMax: env.AUTH_RATE_LIMIT_MAX,
  webOrigin,
  requireOwnerTwoFactor: requireOwnerTwoFactor(),
});
