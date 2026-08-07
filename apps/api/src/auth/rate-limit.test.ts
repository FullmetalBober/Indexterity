import { describe, expect, it } from "vitest";
import { AUTH_RATE_LIMIT_WINDOW_SECONDS, authRateLimit, CREDENTIAL_PATHS } from "./rate-limit";

// The measured symptom in #54: 22 of 25 sign-in attempts were throttled under
// NODE_ENV=production and none with it unset, because better-auth's own default —
// 3 per 10s — was the effective limit while `AUTH_RATE_LIMIT_MAX=20` was the
// documented one. These assertions are about the configured number being the one
// that applies, and about where the counting happens.
describe("authRateLimit", () => {
  it("counts in the database, so the limit is the deployment's and not each pod's", () => {
    expect(authRateLimit(20).storage).toBe("database");
  });

  it("prices every credential endpoint at the configured attempts a minute", () => {
    const rules = authRateLimit(20).customRules;
    for (const path of CREDENTIAL_PATHS) {
      expect(rules[path]).toEqual({ window: AUTH_RATE_LIMIT_WINDOW_SECONDS, max: 20 });
    }
    expect(AUTH_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  // Wildcards, because better-auth's own rule matches these by prefix
  // (`/sign-in/email`, `/sign-in/social`, …) and an exact path would leave the
  // default in place for every variant we did not name.
  it("covers the sign-in and sign-up variants, not one path each", () => {
    const rules = authRateLimit(5).customRules;
    expect(Object.keys(rules)).toContain("/sign-in/*");
    expect(Object.keys(rules)).toContain("/sign-up/*");
  });

  // A rule for /request-password-reset or /send-verification-email would raise
  // better-auth's 3-a-minute ration on endpoints that each send mail to somebody
  // who did not ask for it — a different limit for a different reason.
  it("leaves the mail-sending endpoints at better-auth's own ration", () => {
    const rules = authRateLimit(20).customRules;
    for (const path of [
      "/request-password-reset",
      "/forget-password",
      "/send-verification-email",
    ]) {
      expect(rules[path]).toBeUndefined();
    }
  });

  // Ditto the global limit. The dashboard reads its session through /api/auth on
  // ordinary navigation, so pricing the whole surface at the credential number
  // would throttle reading rather than guessing.
  it("does not set a global window or max", () => {
    const config: Record<string, unknown> = { ...authRateLimit(20) };
    expect(config.window).toBeUndefined();
    expect(config.max).toBeUndefined();
  });

  // Stating `enabled: true` would turn the limiter on for the dev stack and both
  // test suites, where one run signs up dozens of accounts from one address.
  it("leaves `enabled` to better-auth, which means production only", () => {
    const config: Record<string, unknown> = { ...authRateLimit(20) };
    expect("enabled" in config).toBe(false);
  });
});
