import { expect, type Page } from "@playwright/test";

// Every account this suite creates carries this prefix, so the teardown can
// find its own rows and nothing else's — the dev postgres is shared with the
// api's integration suite and with whatever is being developed at the time.
export const E2E_EMAIL_PREFIX = "e2e-";

// Organizations are made on purpose now rather than conjured behind the first
// request, so the suite makes its own — and they need a prefix for the same
// reason the addresses do. `organizations` has no foreign key to `user`, so
// deleting the accounts does NOT take them: the teardown removes these by name.
export const E2E_ORG_PREFIX = "e2e-org-";

export const MONGO_URL = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017";

let counter = 0;

// Unique per test AND per run: postgres keeps rows between runs, and a second
// run reusing an address would fail on the unique constraint rather than on
// anything the test is about.
export function uniqueEmail(label: string): string {
  counter += 1;
  return `${E2E_EMAIL_PREFIX}${label}-${Date.now()}-${counter}@example.test`;
}

export const PASSWORD = "e2e-Passw0rd!";

// Create an account through the UI, make it an organization, and wait for the
// dashboard. Sign-up is the only way in — there is no seeded user, on purpose:
// an account that the tests create is an account the app can actually create.
//
// The org step is not scaffolding. A fresh account belongs to nothing now, and
// the create screen is the first thing it sees; a fixture that skipped it would
// be testing a state the product does not have.
export async function signUpAndLandOnDashboard(page: Page, email: string): Promise<string> {
  await page.goto("/app");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  return createOrgAndLandOnDashboard(page);
}

// Fill in the create-org screen and wait for the dashboard behind it. Named
// after the account so two accounts in one test never share a name on screen.
export async function createOrgAndLandOnDashboard(page: Page): Promise<string> {
  counter += 1;
  const name = `${E2E_ORG_PREFIX}${Date.now()}-${counter}`;
  // Longer than the default, because this is the first thing rendered after a
  // sign-up and what it is really waiting on is scrypt: hashing a password takes
  // ~2s on an idle machine and several times that with a browser, a web server,
  // an api and postgres competing for the same cores. Ten seconds is a coin
  // flip near the end of a full run, and a flaky suite is one nobody reads.
  await expect(page.getByText("Make an organization")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Organization name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
  return name;
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/app");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

// Paste the real mongo, run the preflight, and connect. Leaves the page on the
// dashboard with the new cluster selected.
export async function connectCluster(page: Page, name: string): Promise<void> {
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Connection string").fill(MONGO_URL);
  await page.getByRole("button", { name: "Check access" }).click();
  // The preflight has answered when a connect action appears.
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  const asIs = page.getByRole("button", { name: "Use these credentials as-is" });
  await expect(connect.or(asIs)).toBeVisible();
  await ((await connect.isVisible()) ? connect : asIs).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}
