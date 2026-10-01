import type { ClusterEvent } from "@repo/contracts";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { present } from "~/lib/at";
import { apiError, renderInApp } from "~/test-utils";
import { queryKeys } from "./keys";
import { invalidationKeys, resumeKeys, useLiveClusterEvents } from "./live";

const listClusterEvents = vi.hoisted(() => vi.fn());

// The real client with these calls replaced, through a forwarding Proxy: the
// oRPC client is itself a Proxy over fetch, so spreading it yields `{}` and a
// call this test never set up would answer `undefined` instead of failing.
vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return { ...actual, api: () => overriding(actual.api(), { listClusterEvents }) };
});

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
        while (queue.length > 0) yield present(queue.shift(), "a queued event");
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

// The tab's visibility, as the hook reads it. jsdom answers one fixed value, so
// the property is shadowed on the document for each test and put back after.
let visibility: DocumentVisibilityState = "visible";

function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  listClusterEvents.mockReset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
});

// The mapping is the contract of this module: each event names what it moves,
// checkable against what the worker writes (see live.ts).
describe("invalidationKeys", () => {
  it("a landed collect moves the telemetry and the cluster list", () => {
    expect(invalidationKeys(CLUSTER, { kind: "PASS_FINISHED", task: "collect" })).toEqual([
      queryKeys.collections(CLUSTER),
      queryKeys.clusterIndexesAll(CLUSTER),
      queryKeys.indexSizeSeries(CLUSTER),
      queryKeys.latency(CLUSTER),
      queryKeys.latencySeries(CLUSTER),
      queryKeys.nodes(CLUSTER),
      queryKeys.clusters(),
      queryKeys.passes(CLUSTER),
    ]);
  });

  // And the index inventory with them (#431): its last column says whether
  // something is proposing to change each index, so a pass that rewrites the
  // proposals moves a page on which no measurement changed at all.
  it("analysis passes move the recommendations and the inventory", () => {
    for (const task of ["classify", "suggest"] as const) {
      expect(invalidationKeys(CLUSTER, { kind: "PASS_FINISHED", task })).toEqual([
        queryKeys.recommendations(CLUSTER),
        queryKeys.clusterIndexesAll(CLUSTER),
        queryKeys.clusterWorkloadAll(CLUSTER),
        queryKeys.passes(CLUSTER),
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
        queryKeys.clusterIndexesAll(CLUSTER),
        queryKeys.passes(CLUSTER),
      ]);
    }
  });

  // Probe writes nothing itself — it queues a suggest, whose own event follows —
  // except how long it took (#571), which every pass records.
  it("a probe moves only its own timing", () => {
    expect(invalidationKeys(CLUSTER, { kind: "PASS_FINISHED", task: "probe" })).toEqual([
      queryKeys.passes(CLUSTER),
    ]);
  });

  it("every transition event moves the pipeline", () => {
    for (const kind of ["DROP_HIDDEN", "BUILD_GRADUATED"] as const) {
      expect(invalidationKeys(CLUSTER, { kind, task: null })).toEqual([
        queryKeys.recommendations(CLUSTER),
        queryKeys.activity(CLUSTER),
        queryKeys.roi(CLUSTER),
        queryKeys.clusterIndexesAll(CLUSTER),
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
      queryKeys.clusterIndexesAll(CLUSTER),
    ]);
  });
});

// Everything an event could move, once each: what a tab refetches when it starts
// listening again, having heard nothing while it was hidden.
describe("resumeKeys", () => {
  it("is every key any event names, and each only once", () => {
    const keys = resumeKeys(CLUSTER).map((key) => JSON.stringify(key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(
      new Set(
        [
          queryKeys.collections(CLUSTER),
          queryKeys.clusterIndexesAll(CLUSTER),
          queryKeys.indexSizeSeries(CLUSTER),
          queryKeys.latency(CLUSTER),
          queryKeys.latencySeries(CLUSTER),
          queryKeys.nodes(CLUSTER),
          queryKeys.clusters(),
          queryKeys.recommendations(CLUSTER),
          queryKeys.clusterWorkloadAll(CLUSTER),
          queryKeys.activity(CLUSTER),
          queryKeys.roi(CLUSTER),
          queryKeys.cooldowns(CLUSTER),
          queryKeys.passes(CLUSTER),
        ].map((key) => JSON.stringify(key)),
      ),
    );
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

  // A stream that ends when its subscription is aborted, which is what the
  // oRPC client does with the signal the hook hands it.
  function abortableStreams() {
    listClusterEvents.mockImplementation(
      async (_input: unknown, options?: { signal?: AbortSignal }) => {
        const events = stream();
        options?.signal?.addEventListener("abort", () => events.end());
        return events;
      },
    );
  }

  // #548: a hidden tab holding a stream keeps the api's database from ever
  // suspending, so it lets go — and showing it again reopens the stream and
  // refetches what the missed events would have moved.
  it("closes the stream while the tab is hidden and reopens it with a refetch when shown", async () => {
    abortableStreams();
    const { queryClient, unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
    await waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
    const first = listClusterEvents.mock.calls[0]?.[1]?.signal;

    show("hidden");
    expect(first?.aborted).toBe(true);

    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    show("visible");
    await waitFor(() => expect(listClusterEvents).toHaveBeenCalledTimes(2));
    for (const queryKey of resumeKeys(CLUSTER)) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    expect(listClusterEvents.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    unmount();
  });

  // A tab opened in the background has nobody looking at it yet.
  it("waits for a tab opened in the background to be shown", async () => {
    abortableStreams();
    visibility = "hidden";
    const { unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listClusterEvents).not.toHaveBeenCalled();

    show("visible");
    await waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
    unmount();
  });

  it("opens one stream however many times the tab is shown", async () => {
    abortableStreams();
    const { unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
    await waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
    show("visible");
    show("visible");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listClusterEvents).toHaveBeenCalledOnce();
    unmount();
  });

  // Unmounting while hidden leaves nothing to reopen later.
  it("stops listening for visibility once unmounted", async () => {
    abortableStreams();
    const { unmount } = renderInApp(<Probe clusterId={CLUSTER} />);
    await waitFor(() => expect(listClusterEvents).toHaveBeenCalledOnce());
    show("hidden");
    unmount();
    show("visible");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listClusterEvents).toHaveBeenCalledOnce();
  });
});
