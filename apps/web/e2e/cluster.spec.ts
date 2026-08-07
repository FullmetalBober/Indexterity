import { expect, type Page, test } from "@playwright/test";
import {
  connectCluster,
  MONGO_URL,
  openClusterSettings,
  openConnectForm,
  signUpAndLandOnDashboard,
  uniqueEmail,
} from "./fixtures";

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

    await connectCluster(page, "E2E Primary");

    // Read-only until someone says otherwise — the engine cannot write yet.
    await expect(page.getByText("read-only", { exact: true })).toBeVisible();
    await openClusterSettings(page);
    await expect(page.getByRole("button", { name: "Go live" })).toBeVisible();
  });

  // The preflight is what makes connecting safe: it reports the privileges
  // before anything is stored.
  test("reports what the credentials can do before storing them", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("preflight"));
    await openConnectForm(page);

    await page.getByLabel("Name", { exact: true }).fill("E2E Preflight");
    await page.getByLabel("Connection string").fill(MONGO_URL);
    await page.getByRole("button", { name: "Check access" }).click();

    // Named privileges, not just a yes/no.
    await expect(page.getByText("Index usage stats ($indexStats)")).toBeVisible();
    await expect(page.getByText("Hide/unhide indexes (collMod)")).toBeVisible();
    // Still nothing stored: no cluster in the rail.
    await expect(page.getByText("E2E Preflight")).toHaveCount(0);
  });

  test("refuses a cluster it cannot reach, and says why", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("unreachable"));
    await openConnectForm(page);

    await page.getByLabel("Name", { exact: true }).fill("Nowhere");
    await page.getByLabel("Connection string").fill("mongodb://127.0.0.1:59999");
    await page.getByRole("button", { name: "Check access" }).click();

    await expect(page.getByText(/unreachable/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeHidden();
  });

  test("rejects a connection string that is not mongodb at all", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("scheme"));
    await openConnectForm(page);

    await page.getByLabel("Name", { exact: true }).fill("Evil");
    await page.getByLabel("Connection string").fill("http://169.254.169.254/latest/meta-data");
    await page.getByRole("button", { name: "Check access" }).click();

    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeHidden();
  });

  test("going live is confirmed, and the badge follows", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("golive"));
    await connectCluster(page, "E2E Live");
    await openClusterSettings(page);

    await confirmAction(page, "Go live", "Go live");

    // The badge is in the heading, which every page under the cluster carries.
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
    await openClusterSettings(page);

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

    // The plan lives in Settings → Organization; the policy it constrains lives
    // under the cluster, so this test crosses between them deliberately.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(page.getByText("FREE", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "E2E Plan" }).click();
    await openClusterSettings(page);

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

  // The cluster is an address. Leaving it and coming back has to be the same
  // page, and it has to be reachable by typing the URL — which is most of what
  // #81 bought and what `?cluster=` could never do. The old shape of this test
  // guarded the opposite failure: nav links carried no search param, so coming
  // back keyed the per-cluster reads on null.
  test("a cluster keeps its address across a navigation and a reload", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("reselect"));
    await connectCluster(page, "E2E Reselect");
    const url = page.url();
    expect(url).toMatch(/\/app\/clusters\/[0-9a-f-]+$/);

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(page.getByText("FREE", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "E2E Reselect" }).click();

    await expect(page).toHaveURL(url);
    await expect(page.getByRole("heading", { name: "E2E Reselect" })).toBeVisible();

    // And typed straight in, in a browser that has never been anywhere else.
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "E2E Reselect" })).toBeVisible();
  });

  // The server fetches everything the page draws, and the browser has to
  // receive it rather than fetch it again: cutting off every api call the
  // browser could make leaves only what the SSR payload carried. Without the
  // query cache in that payload the browser hydrates against an empty one, and
  // the whole page reverts to its empty shapes for as long as the refetch
  // takes — which is the failure that made the policy section vanish twice.
  test("renders from what the server sent, not from a second round trip", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("hydration"));
    await connectCluster(page, "E2E Hydrated");
    await openClusterSettings(page);
    await page.getByLabel("Observe window (days)").fill("14");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Policy saved")).toBeVisible();
    const settingsUrl = page.url();

    // Every call the BROWSER would make to the api, cut off. The SSR render is
    // unaffected — the web server dials the api itself, off this page's
    // request — so whatever still draws came across in the payload. This used
    // to block "**/_serverFn/**", which stopped matching anything the moment
    // the server functions went: the test would have kept passing while
    // proving nothing.
    await page.route("**/api/**", (route) => route.abort());
    await page.goto(settingsUrl);

    // The shell, and a per-cluster read that only the loader could have made.
    await expect(page.getByRole("heading", { name: "E2E Hydrated" })).toBeVisible();
    await expect(page.getByLabel("Observe window (days)")).toHaveValue("14");
    // And not one skeleton, with every api call blocked. The skeletons added in
    // #72 are for a cold cache and a client-side cluster switch; a skeleton here
    // would mean the panels stopped reading the SSR payload and started asking
    // again, which is a flash where there was none.
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  });

  // The test above runs with JavaScript on, so it cannot tell server output from
  // a client re-render off the hydrated cache: both look like a drawn page. That
  // blind spot is not hypothetical — evaluating TanStack DB (#42) reverted the
  // whole /app shell to client rendering, halving the server HTML, and the test
  // above stayed green throughout. So this one reads the raw response, which is
  // the only place the distinction exists.
  test("server-renders the cluster page itself, not just a shell to fill in", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("ssr"));
    await connectCluster(page, "E2E ServerRendered");

    // Shares the browser context's cookies, so this is the request the browser
    // makes — but the response before any JavaScript has run.
    const html = await (await page.request.get(page.url())).text();

    // Three markers spread across the tree: the layout's nav, the cluster
    // layout's heading, and a table below the ROI cards. A recoverable SSR
    // error takes out the whole shell rather than one panel, so any of them
    // going missing is the signal.
    expect(html).toContain("Sign out");
    expect(html).toContain("E2E ServerRendered");
    expect(html).toContain("Collections");
    // And the loader awaits every read before this renders, so nothing on the
    // server is ever pending. One skeleton in the response means a panel
    // stopped being server-rendered and nobody would have noticed — the
    // markers above cannot catch it, because a skeleton draws headings too.
    expect(html).not.toContain('data-slot="skeleton"');
  });

  // The free plan allows one, and the limit must be visible before it is hit —
  // on the page with the form, with no navigating to go and find it. A test that
  // clicks through to the org page to read the number is a test agreeing with
  // wherever the number happens to live (#30).
  test("refuses a second cluster on the free plan and says why", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("quota"));
    await connectCluster(page, "E2E Quota One");
    await openConnectForm(page);

    await expect(page.getByText(/1 \/ 1 clusters on the FREE plan/)).toBeVisible();
    await expect(page.getByText("No room for another cluster")).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("E2E Quota Two");
    await page.getByLabel("Connection string").fill(MONGO_URL);
    await page.getByRole("button", { name: "Check access" }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(page.getByText(/FREE plan allows 1 clusters/)).toBeVisible();
  });

  test("disconnecting asks first, then removes the cluster", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("disconnect"));
    await connectCluster(page, "E2E Doomed");
    await openClusterSettings(page);

    await confirmAction(page, "Disconnect", "Disconnect");

    // Nothing left to show, so /app lands on the one thing there is to do.
    await expect(page.getByRole("heading", { name: "Connect a cluster" })).toBeVisible();
    await expect(page.getByText("E2E Doomed")).toHaveCount(0);
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Connect a cluster" })).toBeVisible();
  });
});
