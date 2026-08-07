// better-auth's own rate limiter, made shared and made to mean what we advertise.
//
// There are two limiters on this api and they are not alternatives:
//
//   @fastify/rate-limit (main.ts)  every route, including the oRPC ones
//                                  better-auth never sees. Counters in THIS
//                                  process's memory, so the ceiling is really
//                                  RATE_LIMIT_MAX × replicas and a rollout hands
//                                  the budget back.
//   better-auth's (this file)      /api/auth/* only, per path, and on in
//                                  production alone (it reads NODE_ENV, which the
//                                  api image sets). Path-aware, which the Fastify
//                                  one cannot be: it is the limiter that decides
//                                  what a sign-in costs.
//
// Two things were wrong with that (#54). The tighter limiter was the invisible
// one — better-auth's default is 3 requests per 10s on the credential endpoints,
// so `AUTH_RATE_LIMIT_MAX=20` was documentation for a number that never applied
// to sign-in. And its counters were in memory too, so the limit was per pod:
// non-deterministic under load, since which pod a request lands on decides which
// bucket it spends, and reset on every deploy.
//
// So: the credential endpoints are ruled by the configured number, per minute,
// counted in Postgres where every replica sees the same total. better-auth prunes
// the table itself (it deletes rows past the widest window on each write), so
// this adds a table and no maintenance.
//
// What is deliberately NOT changed:
//
//   - The GLOBAL auth limit stays better-auth's default (100 per 10s). The
//     dashboard reads its session through /api/auth on ordinary navigation, and
//     pricing that at AUTH_RATE_LIMIT_MAX per minute would throttle reading, not
//     guessing.
//   - The mail-sending endpoints stay at better-auth's 3 per minute
//     (/request-password-reset, /forget-password, /send-verification-email).
//     Those are rationed because each one sends an email to somebody who did not
//     ask for it, which is a different limit with a different reason.

// Per minute, which is the unit both env vars are documented in.
export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;

// The endpoints where a request is an attempt at a credential. better-auth's own
// default rule matches these by prefix; these wildcards replace it, so the
// effective limit is the configured one.
export const CREDENTIAL_PATHS = [
  "/sign-in/*",
  "/sign-up/*",
  "/change-password",
  "/change-email",
] as const;

export interface AuthRateLimit {
  readonly storage: "database";
  readonly customRules: Record<string, { readonly window: number; readonly max: number }>;
}

// `enabled` is deliberately absent: better-auth turns its limiter on for
// production only, and stating `true` here would turn it on for the dev stack and
// both test suites, where a run signs up dozens of accounts from one address.
export function authRateLimit(max: number): AuthRateLimit {
  return {
    storage: "database",
    customRules: Object.fromEntries(
      CREDENTIAL_PATHS.map((path) => [path, { window: AUTH_RATE_LIMIT_WINDOW_SECONDS, max }]),
    ),
  };
}
