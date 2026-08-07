import { expect, type Page, test } from "@playwright/test";
import {
  connectCluster,
  createOrgAndLandOnDashboard,
  E2E_ORG_PREFIX,
  PASSWORD,
  signUpAndLandOnDashboard,
  uniqueEmail,
} from "./fixtures";

// Stamp the selected cluster with a value nothing else on the page has. The
// policy is per cluster and read by the dashboard's own keys, so reading it back
// says which cluster the panels are about — which the cluster name in the bar
// does not, because the bar and the panels resolve that separately.
async function setObserveWindow(page: Page, days: string): Promise<void> {
  await page.getByLabel("Observe window (days)").fill(days);
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Policy saved").first()).toBeVisible();
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
    await expect(firstPage.getByText("Tenant A Cluster", { exact: true })).toBeVisible();

    // A completely separate browser context: its own cookie jar, its own account.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signUpAndLandOnDashboard(secondPage, uniqueEmail("tenant-b"));

    await expect(secondPage.getByText("No cluster connected")).toBeVisible();
    await expect(secondPage.getByText("Tenant A Cluster")).toBeHidden();
    // Nor in the org it landed in.
    await expect(secondPage.getByText("Tenant A Cluster", { exact: true })).toHaveCount(0);

    await first.close();
    await second.close();
  });

  // Knowing a cluster id must not be enough — the loader has to scope by org.
  test("guessing another org's cluster id shows nothing", async ({ browser }) => {
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await signUpAndLandOnDashboard(firstPage, uniqueEmail("tenant-c"));
    await connectCluster(firstPage, "Tenant C Cluster");
    // The selected cluster's id is in the query string.
    await expect(firstPage).toHaveURL(/cluster=/);
    const clusterId = new URL(firstPage.url()).searchParams.get("cluster") ?? "";
    expect(clusterId).not.toBe("");

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signUpAndLandOnDashboard(secondPage, uniqueEmail("tenant-d"));
    await secondPage.goto(`/app?cluster=${clusterId}`);

    await expect(secondPage.getByText("No cluster connected")).toBeVisible();
    await expect(secondPage.getByText("Tenant C Cluster")).toBeHidden();

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

    // The second account's team list must not contain the first account.
    await secondPage.getByRole("link", { name: "Organization" }).click();
    await expect(secondPage.getByText(`(${emailA})`)).toHaveCount(0);

    await first.close();
    await second.close();
  });

  // A fresh account belongs to nothing. There is no dashboard behind that, and
  // the api used to hide it by inserting "My Org" on the first request.
  test("a fresh account is asked to make an organization before anything else", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: "Need an account? Sign up" }).click();
    await page.getByLabel("Name").fill("E2E User");
    await page.getByLabel("Email").fill(uniqueEmail("no-org"));
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign up" }).click();

    await expect(page.getByText("Make an organization")).toBeVisible();
    // Signed in, but nothing under /app is drawn yet.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeHidden();

    await createOrgAndLandOnDashboard(page);
    await expect(page.getByText("No cluster connected")).toBeVisible();
  });

  // Switching org had no coverage at all, which is how a report of "the
  // dashboard is empty after switching" had nothing to check itself against.
  // This asserts the whole move: the bar, the cluster list under it, and the
  // panels — the layout derives the selected cluster from the live list while
  // the dashboard reads the one its loader resolved, and those are two different
  // sources that have to agree.
  //
  // Which is also how it passed through the bug in #82. It used to finish on
  // `getByText("Collections")`, and that is a static heading the dashboard draws
  // whether or not a single read answered — so the only thing the test really
  // checked was the bar, which was never the broken half. The panels have to be
  // identified by something ONLY the expected cluster answers, so each cluster
  // gets an observe window nothing else has.
  test("switching org re-points the dashboard, not just the bar", async ({ page }) => {
    const firstOrg = await signUpAndLandOnDashboard(page, uniqueEmail("switch"));
    await connectCluster(page, "Switch Cluster A");
    await expect(page.getByText("Switch Cluster A", { exact: true })).toBeVisible();
    await setObserveWindow(page, "14");

    // A second org, made from the org page. The plugin makes it active.
    await page.getByRole("link", { name: "Organization" }).click();
    const second = `${E2E_ORG_PREFIX}second-${Date.now()}`;
    await page.getByLabel("Start another organization").fill(second);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(`Team — ${second}`)).toBeVisible();

    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByText("No cluster connected")).toBeVisible();
    await connectCluster(page, "Switch Cluster B");
    await expect(page.getByText("Switch Cluster B", { exact: true })).toBeVisible();
    await setObserveWindow(page, "21");

    // Back to the first org, picked by name rather than by position: both
    // options read "(owner)", and a test that takes whichever came first is
    // agreeing with the api's ordering rather than choosing an org.
    await page.getByLabel("Switch organization").click();
    await page.getByRole("option", { name: `${firstOrg} (owner)`, exact: true }).click();

    await expect(page.getByText("Switch Cluster A", { exact: true })).toBeVisible();
    await expect(page.getByText("Switch Cluster B", { exact: true })).toBeHidden();
    // The panels under the bar are about cluster A. Not "not blank" — about A:
    // the failure being defended against is a dashboard still keyed on the
    // previous org's cluster, which draws the same empty shapes as a dashboard
    // keyed on nothing.
    await expect(page.getByLabel("Observe window (days)")).toHaveValue("14");
  });

  // Deleting an org takes its clusters and drops the owner back to the create
  // screen rather than a broken shell.
  test("deleting the only org returns to the create screen", async ({ page }) => {
    const orgName = await signUpAndLandOnDashboard(page, uniqueEmail("delete-org"));
    await connectCluster(page, "Doomed Cluster");
    await expect(page.getByText("Doomed Cluster", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Organization" }).click();
    await page.getByRole("button", { name: "Delete org" }).click();
    // Nothing happens until the org's own name is typed out.
    const confirm = page.getByRole("button", { name: "Delete this organization" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Type/).fill(orgName);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByText("Make an organization")).toBeVisible();
    await expect(page.getByText("Doomed Cluster")).toBeHidden();
  });
});
