import type { ClusterEvent } from "@repo/contracts";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { queryKeys } from "./keys";
import { invalidationKeys, useLiveClusterEvents } from "./live";

const listClusterEvents = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", () => ({
  api: () => ({ listClusterEvents }),
}));

const CLUSTER = "c1";

// A stream the test can feed by hand — what the oRPC client hands the hook is
// an async iterable, so the tests speak the same shape.
function stream() {
  const queue: ClusterEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(event: ClusterEvent) {
      queue.push(event);
      wake?.();
    },
    end() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) yield queue.shift() as ClusterEvent;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function Probe({ clusterId }: { clusterId: string | null }) {
  useLiveClusterEvents(clusterId);
  return null;
}

beforeEach(() => {
  listClusterEvents.mockReset();
});

// The mapping is the contract of this module: each event names what it moves,
// checkable against what the worker writes (see live.ts).
describe("invalidationKeys", () => {
  it("a landed collect moves the telemetry and the cluster list", () => {
    expect(invalidationKeys(CLUSTER, { kind: "PASS_FINISHED", task: "collect" })).toEqual([
      queryKeys.collections(CLUSTER),
      queryKeys.latency(CLUSTER),
      queryKeys.latencySeries(CLUSTER),
      queryKeys.nodes(CLUSTER),
      queryKeys.clusters(),
    ]);
  });

  it("analysis passes move the recommendations and nothing else", () => {
    for (const task of ["classify", "suggest"] as const) {
      expect(invalidationKeys(CLUSTER, { kind: "PASS_FINISHED", task })).toEqual([
        queryKeys.recommendations(CLUSTER),
      ]);
    }
  });

  // The cooldown key rides with these two because finalize is where both
  // regression gates run, and each parks the index it rejected (#159).
  it("execution passes move the pipeline: rows, trail, ROI, parked", () => {
    for (const task of ["apply", "finalize"] as const) {
      expect(invalidationKeys(CLUSTER, { kind: "PASS_FINISHED", task })).toEqual([
        queryKeys.recommendations(CLUSTER),
        queryKeys.activity(CLUSTER),
        queryKeys.roi(CLUSTER),
        queryKeys.cooldowns(CLUSTER),
      ]);
    }
  });

  // Probe writes nothing itself — it queues a suggest, whose own event follows.
  it("a probe moves nothing", () => {
    expect(invalidationKeys(CLUSTER, { kind: "PASS_FINISHED", task: "probe" })).toEqual([]);
  });

  it("every transition event moves the pipeline", () => {
    for (const kind of ["DROP_HIDDEN", "BUILD_GRADUATED"] as const) {
      expect(invalidationKeys(CLUSTER, { kind, task: null })).toEqual([
        queryKeys.recommendations(CLUSTER),
        queryKeys.activity(CLUSTER),
        queryKeys.roi(CLUSTER),
      ]);
    }
  });

  // A regression is the one transition that always writes a cooldown — both
  // places that emit it call recordRegression first — and the parked panel is
  // the only screen that shows what the regression cost.
  it("a regression also moves the parked panel", () => {
    expect(invalidationKeys(CLUSTER, { kind: "REGRESSION_FIRED", task: null })).toEqual([
      queryKeys.recommendations(CLUSTER),
      queryKeys.activity(CLUSTER),
      queryKeys.roi(CLUSTER),
      queryKeys.cooldowns(CLUSTER),
    ]);
  });
});

describe("useLiveClusterEvents", () => {
  it("answers an event by invalidating what it names", async () => {
    const events = stream();
    listClusterEvents.mockResolvedValue(events);
    const { queryClient, unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
    events.push({ kind: "DROP_HIDDEN", task: null });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.recommendations(CLUSTER),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.activity(CLUSTER) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.roi(CLUSTER) });
    events.end();
    unmount();
  });

  it("subscribes to nothing before a cluster exists", () => {
    renderInApp(<Probe clusterId={null} />);
    expect(listClusterEvents).not.toHaveBeenCalled();
  });

  // The api ends every stream on its re-auth cadence, so a clean end is the
  // steady state and the hook has to come back from one on its own.
  it("reconnects after the server closes the stream", async () => {
    const first = stream();
    const second = stream();
    listClusterEvents.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    vi.useFakeTimers();
    try {
      const { unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
      await vi.waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
      first.end();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(listClusterEvents).toHaveBeenCalledTimes(2);
      second.end();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  // 401/403/404 mean this reader may not hear this cluster; retrying cannot
  // change that, and a loop of refused connects is background noise forever.
  it("stops for good when the api refuses the subscription", async () => {
    listClusterEvents.mockRejectedValue(apiError(404, "cluster not found"));
    vi.useFakeTimers();
    try {
      const { unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
      await vi.waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(120_000);
      expect(listClusterEvents).toHaveBeenCalledOnce();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  // A transport failure is transient by assumption — but retried with backoff,
  // not in a tight loop.
  it("retries a dropped connection", async () => {
    const events = stream();
    listClusterEvents
      .mockRejectedValueOnce(apiError(500, "bad gateway"))
      .mockResolvedValueOnce(events);
    vi.useFakeTimers();
    try {
      const { unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
      await vi.waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
      // First failure backs off to two seconds; one is not enough.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(listClusterEvents).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(listClusterEvents).toHaveBeenCalledTimes(2);
      events.end();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
