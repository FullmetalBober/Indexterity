import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { NO_RECOMMENDATIONS, useRecommendations } from "./pipeline";
import type { Read } from "./read";

const listRecommendations = vi.hoisted(() => vi.fn());

// The real client with these calls replaced, through a forwarding Proxy: the
// oRPC client is itself a Proxy over fetch, so spreading it yields `{}` and a
// call this test never set up would answer `undefined` instead of failing.
vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return { ...actual, api: () => overriding(actual.api(), { listRecommendations }) };
});

const CLUSTER = "c1";

// The three answers a read can give, observed at the hook boundary rather than
// through a panel: a panel can only be as honest as what it is handed, and #289
// was the hook handing "empty" for "broken".
let latest: Read<unknown> | null = null;

function Probe() {
  latest = useRecommendations(CLUSTER);
  return null;
}

beforeEach(() => {
  latest = null;
  listRecommendations.mockReset();
});

describe("a per-cluster read", () => {
  it("reports a genuinely empty cluster as empty and NOT failed", async () => {
    listRecommendations.mockResolvedValue({ ...NO_RECOMMENDATIONS, clusterId: CLUSTER });
    renderInApp(<Probe />);
    await waitFor(() => expect(latest?.pending).toBe(false));
    expect(latest?.failed).toBe(false);
  });

  // The bug. The payload falls back to the same empty shape either way, so
  // `failed` is the only thing separating "your indexes are all fine" from "we
  // could not ask".
  it("reports a failed read as failed, with the empty payload beneath it", async () => {
    listRecommendations.mockRejectedValue(apiError(500, "boom"));
    renderInApp(<Probe />);
    await waitFor(() => expect(latest?.failed).toBe(true));
    expect(latest?.pending).toBe(false);
    expect(latest?.data).toEqual(NO_RECOMMENDATIONS);
  });

  // Neither, while the first fetch is out — the distinction #72 added, which
  // this must not disturb.
  it("is neither empty nor failed while it is still being asked", () => {
    listRecommendations.mockReturnValue(new Promise(() => {}));
    renderInApp(<Probe />);
    expect(latest?.pending).toBe(true);
    expect(latest?.failed).toBe(false);
  });

  it("asks again when retried, and clears the failure once it answers", async () => {
    listRecommendations.mockRejectedValueOnce(apiError(500, "boom"));
    renderInApp(<Probe />);
    await waitFor(() => expect(latest?.failed).toBe(true));

    listRecommendations.mockResolvedValue({
      ...NO_RECOMMENDATIONS,
      clusterId: CLUSTER,
      total: 3,
    });
    latest?.retry();
    await waitFor(() => expect(latest?.failed).toBe(false));
    expect(listRecommendations).toHaveBeenCalledTimes(2);
  });

  // A poll failing behind data we already have must NOT blank the panel: the
  // last good answer is still the best available, and replacing a populated
  // table with an error would be a false claim in the other direction.
  it("keeps a good answer when a later refetch fails", async () => {
    listRecommendations.mockResolvedValueOnce({
      ...NO_RECOMMENDATIONS,
      clusterId: CLUSTER,
      total: 7,
    });
    renderInApp(<Probe />);
    await waitFor(() => expect(latest?.pending).toBe(false));

    listRecommendations.mockRejectedValue(apiError(500, "boom"));
    latest?.retry();
    await waitFor(() => expect(listRecommendations).toHaveBeenCalledTimes(2));
    expect(latest?.data).toMatchObject({ total: 7 });
  });
});
