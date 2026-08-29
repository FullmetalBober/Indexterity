import { expect } from "@playwright/test";
import { connectCluster, signUpAndLandOnDashboard, test, uniqueEmail } from "./fixtures";

// Loaders warm rather than block (D117), asserted from the reader's side.
//
// The claim is that a click hands over the new page immediately and each panel
// draws its own skeleton until its read answers — not that the loader returns
// early, which is all a unit test can see. What makes it worth an e2e test is
// that the failure is invisible to every other kind: an awaited loader renders
// the correct page with the correct data, just later, so nothing throws, nothing
// is missing, and the only symptom is that the previous page stayed on screen.
//
// The settings tab is the case, because its second read dials the customer's
// cluster — the one navigation in the app that can block on somebody else's
// network. Held open here on purpose, since against a local mongod the real dial
// answers too fast to observe either behaviour.
test.describe("navigating between cluster tabs", () => {
  test("the settings page arrives before its cluster dial answers", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("nav"));
    // Leaves the browser on this cluster's overview, with the settings route
    // unvisited — so its dial is genuinely cold and the click has to pay for it.
    await connectCluster(page, "E2E Navigation");

    let held = 0;
    await page.route(/atabase/i, async (route) => {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

    await page
      .getByRole("navigation", { name: "Cluster" })
      .getByRole("link", { name: "Settings" })
      .click();

    // The whole assertion: this text lives ONLY in ObserveSectionSkeleton, so
    // seeing it means the settings page is mounted and drawing while the read it
    // is waiting on is still out. An awaited loader cannot produce this frame —
    // the cache would be full before the component mounted, and the reader would
    // still be looking at the overview.
    await expect(page.getByText("Asking the cluster which databases it has")).toBeVisible({
      timeout: 2500,
    });
    expect(page.url()).toContain("/settings");
    // Not a vacuous pass: if the read is ever renamed out from under that
    // pattern, nothing is held, the dial answers at local speed and the frame
    // above is a race rather than a fact.
    expect(held, "the databases read was never intercepted").toBe(1);

    // And it resolves into the real section rather than staying an outline.
    await expect(page.getByLabel("Observe window (days)")).toBeVisible();
  });

  // The navigation nothing can preload, whatever the input device: it is not an
  // interaction with a link at all. `/app` reads the org and the cluster list to
  // decide where the reader meant, so its loader blocks by design — which is
  // what `defaultPendingComponent` is for, and the one path that still reaches
  // it. Kept here rather than in touch.spec.ts because nothing about it is
  // touch-specific; intent preloading never applied to it in the first place.
  test("/app resolves to a cluster with nothing having been preloaded", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("redirect"));
    await connectCluster(page, "E2E Redirect");

    await page.goto("/app");

    await expect(page).toHaveURL(/\/app\/clusters\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "E2E Redirect" })).toBeVisible();
  });
});
