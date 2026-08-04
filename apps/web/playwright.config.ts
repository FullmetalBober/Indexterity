import { defineConfig, devices } from "@playwright/test";

// End-to-end: a real browser against the built web server, which talks to the
// built api, which talks to a real postgres and a real mongo. Nothing is
// mocked. This is the only layer that exercises the whole chain — the
// component tests stop at ~/lib/api, and the api's integration suite starts
// after it.
//
// It lives in apps/web because the browser is this app's surface, but it does
// start the api too (../api/dist/main.js). Both must be built first; the
// test:e2e script does that.
//
// Three servers, not two. The browser calls the api directly now, and the
// session cookie only reaches the api because both answer on ONE origin — so
// the suite puts the same /api-and-everything-else split in front of them that
// the ingress does in production and nginx does in compose. The two ports below
// are internal: nothing in a test addresses them.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3210);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3211);
const ORIGIN_PORT = Number(process.env.E2E_ORIGIN_PORT ?? 3212);

const WEB_INTERNAL = `http://127.0.0.1:${WEB_PORT}`;
const API_INTERNAL = `http://127.0.0.1:${API_PORT}`;

// The only address the browser knows.
export const WEB_URL = `http://127.0.0.1:${ORIGIN_PORT}`;

const apiEnv = {
  ...process.env,
  API_PORT: String(API_PORT),
  // Both are the public origin, which is the dashboard's: better-auth appends
  // /api/auth to BETTER_AUTH_URL itself, and WEB_ORIGIN is what it trusts for
  // auth requests and redirect targets. Pointing either at the api's own port
  // would make every sign-in from the browser look cross-site.
  BETTER_AUTH_URL: WEB_URL,
  WEB_ORIGIN: WEB_URL,
  // Sign-up is invite-only by default, and every test needs its own account.
  SIGNUP_MODE: "open",
  // The suite's mongo is on localhost, which the SSRF guard blocks by design.
  ALLOW_PRIVATE_CLUSTER_TARGETS: "true",
  // Verification would send mail and block sign-in on a link nobody can click.
  REQUIRE_EMAIL_VERIFICATION: "false",
  // The scheduler would start collecting from the test clusters mid-assertion.
  RUN_WORKER: "false",
  // The suite signs up an account per test from one address, which the
  // brute-force budget is right to distrust in production and wrong to here.
  RATE_LIMIT_MAX: "5000",
  AUTH_RATE_LIMIT_MAX: "500",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-secret",
  MASTER_KEY:
    process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef".repeat(2)).toString("base64"),
};

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  // Shared postgres and mongo, and tests that sign up, connect and disconnect
  // clusters. Serial keeps the failures about the app rather than about two
  // tests racing for the same rows.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI === "true",
  retries: process.env.CI === "true" ? 1 : 0,
  // The html report is what the failure artefact uploads in CI.
  reporter:
    process.env.CI === "true" ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node ../api/dist/main.js",
      url: `${API_INTERNAL}/api/health`,
      env: apiEnv,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      command: "node .output/server/index.mjs",
      url: WEB_INTERNAL,
      // API_URL is the web server's own SSR reads, which go straight to the api
      // rather than back out through the proxy — there is no cookie to make
      // first-party server-side, only the caller's to forward.
      env: {
        ...process.env,
        PORT: String(WEB_PORT),
        API_URL: API_INTERNAL,
        WEB_ORIGIN: WEB_URL,
      },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      // Answers on WEB_URL and is the only address the browser uses. Its
      // readiness check goes through to the api, so it also proves the /api
      // route is wired before a single test runs.
      command: "node ./e2e/origin-proxy.mjs",
      url: `${WEB_URL}/api/health`,
      env: {
        ...process.env,
        E2E_ORIGIN_PORT: String(ORIGIN_PORT),
        E2E_API_URL: API_INTERNAL,
        E2E_WEB_URL: WEB_INTERNAL,
      },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  ],
});
