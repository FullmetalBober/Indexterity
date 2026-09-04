import { describe, expect, it, vi } from "vitest";
import { runLoader } from "~/test-utils";
import { Route as OverviewRoute } from "./app.clusters.$clusterId.index";
import { Route as IndexesRoute } from "./app.clusters.$clusterId.indexes";
import { Route as SettingsRoute } from "./app.clusters.$clusterId.settings";

// What these pin is that the cluster loaders WARM without waiting.
//
// The router keeps the previous page mounted until a loader resolves, so an
// awaited warm is a click with no visible answer for the length of the reads —
// and both of these pages already draw a skeleton per panel off react-query's
// own pending flag, which an awaited loader makes unreachable by filling the
// cache before the component mounts.
//
// A regression here fails as a TIMEOUT rather than an assertion: the stalled
// client's reads never answer, so a loader that awaits them never returns.
//
// jsdom means `import.meta.env.SSR` is false, so this exercises the browser
// branch. The server's is the other half of the same line and deliberately DOES
// await — its render is the SSR payload.

// `runLoader` (test-utils) runs the loader the app actually registers, not a
// copy of its body — a copy would keep passing while the real loader grew an
// await.

// Every read accepted and none of them answered, which is what a slow cluster
// looks like from the loader's side.
function stalledClient() {
  return { ensureQueryData: vi.fn(() => new Promise<never>(() => {})) };
}

describe("cluster route loaders", () => {
  // Nine reads, none of which the reader has to wait on to see the page.
  it("hands over the overview before its reads answer", async () => {
    const queryClient = stalledClient();
    await runLoader(OverviewRoute, { params: { clusterId: "c1" }, context: { queryClient } });
    // Returning early is only half of it — a loader that warmed nothing would
    // also return early, and every panel would then fetch on mount instead.
    expect(queryClient.ensureQueryData).toHaveBeenCalledTimes(9);
  });

  // The one that mattered most: the second read here dials the customer's
  // cluster, so this navigation used to block on a connection to somebody's
  // production server — and on an unreachable one, on a timeout.
  it("hands over the settings page before the cluster dial answers", async () => {
    const queryClient = stalledClient();
    await runLoader(SettingsRoute, { params: { clusterId: "c1" }, context: { queryClient } });
    expect(queryClient.ensureQueryData).toHaveBeenCalledTimes(2);
  });

  // Both tables' first pages and the roster. WHICH key each warms is the indexes
  // route's own test, beside its page.
  it("hands over the indexes page before its reads answer", async () => {
    const queryClient = stalledClient();
    await runLoader(IndexesRoute, { params: { clusterId: "c1" }, context: { queryClient } });
    expect(queryClient.ensureQueryData).toHaveBeenCalledTimes(3);
  });
});
