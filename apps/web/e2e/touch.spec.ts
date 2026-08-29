import { expect } from "@playwright/test";
import { connectCluster, signUpAndLandOnDashboard, test, uniqueEmail } from "./fixtures";

// What a TAP does, which is not what a hover does (#401).
//
// Runs only under the `touch` project (playwright.config.ts). The issue this
// came from assumed touch was the starved input — no hover, so no intent
// preload, so every navigation pays for its loader in full. Measured, it is the
// opposite, and it is worth writing down because it is the reverse of the
// intuition: `Link`'s `onTouchStart` calls `doPreload()` DIRECTLY, with no
// `preloadDelay` timer in front of it (see link.js), where hover and focus both
// go through `enqueueIntentPreload` and wait out `defaultPreloadDelay`. So a tap
// is the one interaction that always preloads, and it does so earlier than any
// pointer can.
//
// That makes this the input where a loader blocking navigation (D117) is HARDEST
// to see, not easiest — the reads are already in flight before the tap lands. It
// is also a second code path nothing else exercises.
test.describe("navigating by tap", () => {
  test("touching a link starts its reads before the tap completes", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("touch"));
    await connectCluster(page, "E2E Touch");

    const calls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) calls.push(request.url());
    });

    // touchstart with no touchend, so nothing navigates and anything that
    // arrives can only be the preload.
    await page
      .getByRole("navigation", { name: "Cluster" })
      .getByRole("link", { name: "Settings" })
      .dispatchEvent("touchstart");
    // Far inside defaultPreloadDelay (200ms), which is the assertion: the delay
    // does not apply to this path. A hover measured at the same point does
    // nothing at all.
    await page.waitForTimeout(50);

    expect(calls.length, `no reads within 50ms of touchstart: ${calls.join(", ")}`).toBeGreaterThan(
      0,
    );
    expect(calls.some((url) => /policy|database/.test(url))).toBe(true);
  });

  test("tapping through still hands over the page before the reads answer", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("touch-nav"));
    await connectCluster(page, "E2E Touch Nav");

    // Held open because the preload above means these reads are already out by
    // the time the tap completes — against a local mongod they would also be
    // finished, and a page that blocked would be indistinguishable from one that
    // did not.
    let held = 0;
    await page.route(/atabase/i, async (route) => {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

    await page
      .getByRole("navigation", { name: "Cluster" })
      .getByRole("link", { name: "Settings" })
      .tap();

    // Only ObserveSectionSkeleton carries this text.
    await expect(page.getByText("Asking the cluster which databases it has")).toBeVisible({
      timeout: 2500,
    });
    expect(page.url()).toContain("/settings");
    expect(held, "the databases read was never intercepted").toBe(1);
    await expect(page.getByLabel("Observe window (days)")).toBeVisible();
  });
});
