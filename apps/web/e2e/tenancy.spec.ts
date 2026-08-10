import { expect, type Page } from "@playwright/test";
import {
  connectCluster,
  createOrgAndLandOnDashboard,
  E2E_ORG_PREFIX,
  openClusterSettings,
  PASSWORD,
  signUpAndLandOnDashboard,
  test,
  uniqueEmail,
} from "./fixtures";

// Stamp the selected cluster with a value nothing else on the page has. The
// policy is per cluster and read by the cluster route's own key, so reading it
// back says which cluster the page is about — which a name in the rail does
// not, because the rail lists every cluster the org has.
async function setObserveWindow(page: Page, days: string): Promise<void> {
  await openClusterSettings(page);
  await page.getByLabel("Observe window (days)").fill(days);
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Policy saved").first()).toBeVisible();
}

// Open Settings → Organizations, which is where a second organization is made
// and where invitations addressed to you are answered.
async function openOrganizations(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("link", { name: "Organizations" }).click();
  await expect(page.getByText("Start another organization")).toBeVisible();
}

// A leak here is one customer seeing another's clusters, so it is worth
// checking through the browser and not only in the api's own tests: the web
// server forwards the session cookie, and forwarding the wrong one — or none —
// would be invisible to every layer below it.
test.describe("tenancy", () => {
  test("a second account sees none of the first account's clusters", async ({ browser }) => {
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await signUpAndLandOnDashboard(firstPage, uniqueEmail("tenant-a"));
    await connectCluster(firstPage, "Tenant A Cluster");

    // A completely separate browser context: its own cookie jar, its own account.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signUpAndLandOnDashboard(secondPage, uniqueEmail("tenant-b"));

    // An org with no clusters lands on the one thing there is to do.
    await expect(secondPage.getByRole("heading", { name: "Connect a cluster" })).toBeVisible();
    // Not in the rail, which lists every cluster this org has.
    await expect(secondPage.getByText("Tenant A Cluster")).toHaveCount(0);

    await first.close();
    await second.close();
  });

  // Knowing a cluster id must not be enough — the route has to scope by org.
  test("guessing another org's cluster id shows nothing", async ({ browser }) => {
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await signUpAndLandOnDashboard(firstPage, uniqueEmail("tenant-c"));
    await connectCluster(firstPage, "Tenant C Cluster");
    // The cluster's id is the address now, rather than a query string on /app.
    await expect(firstPage).toHaveURL(/\/app\/clusters\/[0-9a-f-]+$/);
    const clusterId = firstPage.url().split("/").pop() ?? "";
    expect(clusterId).not.toBe("");

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signUpAndLandOnDashboard(secondPage, uniqueEmail("tenant-d"));
    await secondPage.goto(`/app/clusters/${clusterId}`);

    // Bounced off it entirely rather than shown an empty version of it.
    await expect(secondPage).toHaveURL(/\/app\/clusters\/new$/);
    await expect(secondPage.getByText("Tenant C Cluster")).toHaveCount(0);

    await first.close();
    await second.close();
  });

  test("each new account makes its own organization", async ({ browser }) => {
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    const emailA = uniqueEmail("org-a");
    await signUpAndLandOnDashboard(firstPage, emailA);

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signUpAndLandOnDashboard(secondPage, uniqueEmail("org-b"));

    // The second account's member list must not contain the first account.
    await secondPage
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(secondPage.getByText(`(${emailA})`)).toHaveCount(0);

    await first.close();
    await second.close();
  });

  // A fresh account belongs to nothing. There is no app behind that, and the
  // api used to hide it by inserting "My Org" on the first request.
  test("a fresh account is asked to make an organization before anything else", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: "Need an account? Sign up" }).click();
    await page.getByLabel("Name", { exact: true }).fill("E2E User");
    await page.getByLabel("Email").fill(uniqueEmail("no-org"));
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign up" }).click();

    await expect(page.getByText("Make an organization")).toBeVisible({ timeout: 30_000 });
    // Signed in, but nothing under /app is drawn yet — not even the nav, because
    // every link in it would go somewhere with the same nothing behind it.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();

    await createOrgAndLandOnDashboard(page);
  });

  // Switching org had no coverage at all, which is how a report of "the
  // dashboard is empty after switching" had nothing to check itself against.
  //
  // It also passed straight through the bug in #82, because it used to finish on
  // `getByText("Collections")` — a static heading the page draws whether or not
  // a read answered. The panels have to be identified by something ONLY the
  // expected cluster answers, so each cluster gets an observe window nothing
  // else has.
  test("switching org re-points the app, not just the rail", async ({ page }) => {
    const firstOrg = await signUpAndLandOnDashboard(page, uniqueEmail("switch"));
    await connectCluster(page, "Switch Cluster A");
    await setObserveWindow(page, "14");

    // A second org. The plugin makes it active, and an org with no clusters
    // lands on the connect page.
    await openOrganizations(page);
    const second = `${E2E_ORG_PREFIX}second-${Date.now()}`;
    await page.getByLabel("Name", { exact: true }).fill(second);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page.getByRole("heading", { name: "Connect a cluster" })).toBeVisible();

    await connectCluster(page, "Switch Cluster B");
    await setObserveWindow(page, "21");

    // Back to the first org, picked by name rather than by position: both
    // options read "(owner)", and a test that takes whichever came first is
    // agreeing with the api's ordering rather than choosing an org.
    await page.getByLabel("Switch organization").click();
    await page.getByRole("option", { name: `${firstOrg} (owner)`, exact: true }).click();

    await expect(page.getByRole("heading", { name: "Switch Cluster A" })).toBeVisible();
    await expect(page.getByText("Switch Cluster B")).toHaveCount(0);
    // And the page below it is about cluster A. Not "not blank" — about A: the
    // failure being defended against is an app still pointed at the previous
    // org's cluster, which draws the same empty shapes as one pointed at
    // nothing.
    await openClusterSettings(page);
    await expect(page.getByLabel("Observe window (days)")).toHaveValue("14");
  });

  // Deleting an org takes its clusters and drops the owner back to the create
  // screen rather than a broken shell.
  test("deleting the only org returns to the create screen", async ({ page }) => {
    const orgName = await signUpAndLandOnDashboard(page, uniqueEmail("delete-org"));
    await connectCluster(page, "Doomed Cluster");

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("button", { name: "Delete org" }).click();
    // Nothing happens until the org's own name is typed out.
    const confirm = page.getByRole("button", { name: "Delete this organization" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Type/).fill(orgName);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByText("Make an organization")).toBeVisible();
    await expect(page.getByText("Doomed Cluster")).toHaveCount(0);
  });
});
