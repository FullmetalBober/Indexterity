import { expect } from "@playwright/test";
import { connectCluster, signUpAndLandOnDashboard, test, uniqueEmail } from "./fixtures";

// `defaultPreload: "intent"` (router.tsx), asserted by what it is for rather
// than by reading the setting back.
//
// The claim is that resting the pointer on a cluster link runs that route's
// loader — seven reads on the cluster page — so the click lands on data already
// in the query cache. That is observable and nothing else in the suite covers
// it: every other spec clicks, and a click preloads and navigates in one motion,
// so the two are indistinguishable from the outside.
test.describe("intent preloading", () => {
  test("resting the pointer on a cluster link fetches before the click", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("preload"));
    await connectCluster(page, "E2E Preloaded");

    // A FULL load of another page, not a click through to it. Connecting a
    // cluster leaves you on that cluster's page, so its seven reads are already
    // in the query cache and a preload would correctly fetch nothing — the test
    // would go green on an empty cache rather than on the behaviour. Reloading
    // elsewhere gives a fresh client cache with the cluster route unvisited,
    // which is the state a preload is for.
    await page.goto("/app/settings");
    await page.waitForLoadState("networkidle");

    const calls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) calls.push(request.url());
    });

    const link = page.getByRole("link", { name: /E2E Preloaded/ }).first();
    await link.hover();
    // Past defaultPreloadDelay (200ms) plus the loader's own round trips. Not an
    // expect-poll, because the assertion is about what happened WITHOUT a click:
    // waiting for the condition would pass on requests a later click caused.
    await page.waitForTimeout(1500);

    expect(calls.length, `no api calls after hovering: ${calls.join(", ")}`).toBeGreaterThan(0);
    // And the reads are the cluster page's own, not the shell's.
    expect(
      calls.some((url) => /recommendations|roi|latency|collections|nodes|actions/.test(url)),
    ).toBe(true);
  });
});
