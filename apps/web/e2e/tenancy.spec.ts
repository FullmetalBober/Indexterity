import { expect, test } from "@playwright/test";
import {
  connectCluster,
  createOrgAndLandOnDashboard,
  PASSWORD,
  signUpAndLandOnDashboard,
  uniqueEmail,
} from "./fixtures";

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
