import { defineConfig, devices } from "@playwright/test";

// End-to-end: a real browser against the built web server, which talks to the
// built api, which talks to a real postgres and a real mongo. Nothing is
// mocked. This is the only layer that exercises the whole chain — the
// component tests stop at ~/lib/app-server, and the api's integration suite
// starts after it.
//
// It lives in apps/web because the browser is this app's surface, but it does
// start the api too (../api/dist/main.js). Both must be built first; the
// test:e2e script does that.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3210);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3211);

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

const apiEnv = {
  ...process.env,
  API_PORT: String(API_PORT),
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
      url: `${API_URL}/health`,
      env: apiEnv,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      command: "node .output/server/index.mjs",
      url: WEB_URL,
      env: { ...process.env, PORT: String(WEB_PORT), API_URL, WEB_ORIGIN: WEB_URL },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  ],
});
