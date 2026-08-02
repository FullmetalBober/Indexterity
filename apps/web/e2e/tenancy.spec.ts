import { expect, test } from "@playwright/test";
import { connectCluster, signUpAndLandOnDashboard, uniqueEmail } from "./fixtures";

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

  test("each new account lands in its own organization", async ({ browser }) => {
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    const emailA = uniqueEmail("org-a");
    await signUpAndLandOnDashboard(firstPage, emailA);

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signUpAndLandOnDashboard(secondPage, uniqueEmail("org-b"));

    // The second account's team list must not contain the first account.
    await expect(secondPage.getByText(`(${emailA})`)).toHaveCount(0);

    await first.close();
    await second.close();
  });
});
