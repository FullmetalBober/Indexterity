import { expect, type Page, test } from "@playwright/test";
import { connectCluster, MONGO_URL, signUpAndLandOnDashboard, uniqueEmail } from "./fixtures";

// Open a ConfirmButton and press its action. The label appears twice once the
// dialog is open — on the trigger and on the action — so the action has to be
// scoped to the dialog or the click lands back on the trigger.
async function confirmAction(page: Page, trigger: string, action: string): Promise<void> {
  await page.getByRole("button", { name: trigger, exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
}

// The full chain against a real mongo: the browser fills a form, the web server
// calls the api, the api dials the cluster and encrypts what it stores.
test.describe("cluster lifecycle", () => {
  test("connects a cluster, and it starts read-only", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("cluster"));
    await expect(page.getByText("No cluster connected")).toBeVisible();

    await connectCluster(page, "E2E Primary");

    // Read-only until someone says otherwise — the engine cannot write yet.
    await expect(page.getByText("read-only", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go live" })).toBeVisible();
    await expect(page.getByText("No cluster connected")).toBeHidden();
  });

  // The preflight is what makes connecting safe: it reports the privileges
  // before anything is stored.
  test("reports what the credentials can do before storing them", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("preflight"));

    await page.getByLabel("Name").fill("E2E Preflight");
    await page.getByLabel("Connection string").fill(MONGO_URL);
    await page.getByRole("button", { name: "Check access" }).click();

    // Named privileges, not just a yes/no.
    await expect(page.getByText("Index usage stats ($indexStats)")).toBeVisible();
    await expect(page.getByText("Hide/unhide indexes (collMod)")).toBeVisible();
    // Still nothing stored.
    await expect(page.getByText("No cluster connected")).toBeVisible();
  });

  test("refuses a cluster it cannot reach, and says why", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("unreachable"));

    await page.getByLabel("Name").fill("Nowhere");
    await page.getByLabel("Connection string").fill("mongodb://127.0.0.1:59999");
    await page.getByRole("button", { name: "Check access" }).click();

    await expect(page.getByText(/unreachable/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeHidden();
  });

  test("rejects a connection string that is not mongodb at all", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("scheme"));

    await page.getByLabel("Name").fill("Evil");
    await page.getByLabel("Connection string").fill("http://169.254.169.254/latest/meta-data");
    await page.getByRole("button", { name: "Check access" }).click();

    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeHidden();
  });

  test("going live is confirmed, and the badge follows", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("golive"));
    await connectCluster(page, "E2E Live");

    await confirmAction(page, "Go live", "Go live");

    await expect(page.getByText("live", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Make read-only" })).toBeVisible();

    // And back — no confirmation needed to take permission away.
    await page.getByRole("button", { name: "Make read-only" }).click();
    await expect(page.getByText("read-only", { exact: true })).toBeVisible();
  });

  // Policy is stored by the api and re-read by the loader; a round trip through
  // a reload is the only way to know it was persisted rather than kept in state.
  test("saves policy and reads it back after a reload", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("policy"));
    await connectCluster(page, "E2E Policy");

    // Only fields the free plan includes — the automation ones are gated and
    // have their own test below.
    await page.getByLabel("Observe window (days)").fill("14");
    await page.getByLabel("Workload analysis").check();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Policy saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Observe window (days)")).toHaveValue("14");
    await expect(page.getByLabel("Workload analysis")).toBeChecked();
  });

  // The free plan gives away the analysis and sells the automation, so the
  // refusal has to be clear that the recommendations still arrive — the same
  // save can also fail because the caller is not an owner, and sending someone
  // after the wrong problem wastes their day.
  test("explains that unattended changes are not on this plan, and saves the rest", async ({
    page,
  }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("plan"));
    await connectCluster(page, "E2E Plan");

    // The plan lives on the Organization page now; the policy it constrains
    // lives on the dashboard, so this test crosses between them deliberately.
    await page.getByRole("link", { name: "Organization" }).click();
    await expect(page.getByText("FREE")).toBeVisible();
    await page.getByRole("link", { name: "Dashboard" }).click();

    // Index suggestions are free, and saving them proves it.
    await page.getByLabel("Workload analysis").check();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Policy saved")).toBeVisible();

    // Automation is not.
    await page.getByLabel("Auto-approve score ≥").fill("70");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText(/approve any of them yourself/)).toBeVisible();

    // And turning it back off still saves.
    await page.getByLabel("Auto-approve score ≥").fill("");
    await page.getByLabel("Observe window (days)").fill("21");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Policy saved").first()).toBeVisible();
  });

  // The free plan allows one, and the limit must be visible before it is hit.
  test("refuses a second cluster on the free plan and says why", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("quota"));
    await connectCluster(page, "E2E Quota One");
    await page.getByRole("link", { name: "Organization" }).click();
    await expect(page.getByText(/1 \/ 1 clusters/)).toBeVisible();
    await page.getByRole("link", { name: "Dashboard" }).click();

    await page.getByLabel("Name").fill("E2E Quota Two");
    await page.getByLabel("Connection string").fill(MONGO_URL);
    await page.getByRole("button", { name: "Check access" }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(page.getByText(/FREE plan allows 1 clusters/)).toBeVisible();
  });

  test("disconnecting asks first, then removes the cluster", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("disconnect"));
    await connectCluster(page, "E2E Doomed");

    await confirmAction(page, "Disconnect", "Disconnect");

    await expect(page.getByText("No cluster connected")).toBeVisible();
    await page.reload();
    await expect(page.getByText("No cluster connected")).toBeVisible();
  });
});
