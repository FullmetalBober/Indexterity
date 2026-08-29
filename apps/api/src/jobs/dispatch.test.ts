import type { JobHelpers } from "graphile-worker";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db";
import { stub } from "../test-utils";
import { dispatchToAllClusters } from "./dispatch";

const CLUSTERS = [{ id: "cluster-a" }, { id: "cluster-b" }];

// Handed in, not mocked out. This used to be a vi.mock of ./db replacing the
// module-level jobDb() the function reached for; now the database is an argument,
// so the fake is a value in the test rather than a rewritten import — which is
// the whole point of the change that moved it there.
const db = stub<Database>({
  select: () => ({ from: () => Promise.resolve(CLUSTERS) }),
});
vi.mock("../metrics", () => ({ observeClusterFleet: () => undefined }));

function helpers() {
  const addJob = vi.fn(() => Promise.resolve());
  return {
    spy: addJob,
    helpers: stub<JobHelpers>({ addJob, logger: { info: () => undefined } }),
  };
}

describe("dispatchToAllClusters", () => {
  it("enqueues the task once per cluster", async () => {
    const { spy, helpers: h } = helpers();
    await expect(dispatchToAllClusters(db, "collect", h)).resolves.toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { clusterId: "cluster-a" },
      { clusterId: "cluster-b" },
    ]);
  });

  // The load-bearing bit. A job key dedupes a job still WAITING; graphile-worker's
  // own add_job clears the key of an already-locked job and inserts a new one, so
  // nothing stops a second collect starting while the first is still walking the
  // cluster. Two racing collects would double-count `observations` — the number the
  // trust gate reads as how many times we looked — and could write two runs whose
  // spans overlap, which the exclusion constraint rejects mid-collect. A queue per
  // cluster and task is what makes graphile-worker run them one at a time.
  it("gives each cluster its own queue so a task cannot overlap itself", async () => {
    const { spy, helpers: h } = helpers();
    await dispatchToAllClusters(db, "collect", h);

    const options = spy.mock.calls.map((call) => (call as unknown[])[2] as Record<string, unknown>);
    expect(options.map((o) => o.queueName)).toEqual(["collect:cluster-a", "collect:cluster-b"]);
    // Two clusters must NOT share a queue, or one slow cluster stalls the fleet.
    expect(new Set(options.map((o) => o.queueName)).size).toBe(2);
  });

  it("keys the queue by task as well, so a probe never waits behind a collect", async () => {
    const collect = helpers();
    const probe = helpers();
    await dispatchToAllClusters(db, "collect", collect.helpers);
    await dispatchToAllClusters(db, "probe", probe.helpers);

    const queueOf = (spy: ReturnType<typeof helpers>["spy"]) =>
      (spy.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(queueOf(collect.spy).queueName).toBe("collect:cluster-a");
    expect(queueOf(probe.spy).queueName).toBe("probe:cluster-a");
    // The five-minute probe must not queue behind a collect walking ten thousand
    // collections, so the two tasks are deliberately on different queues.
    expect(queueOf(collect.spy).queueName).not.toBe(queueOf(probe.spy).queueName);
  });

  it("still dedupes a pending job rather than piling them up", async () => {
    const { spy, helpers: h } = helpers();
    await dispatchToAllClusters(db, "collect", h);
    const options = (spy.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options.jobKey).toBe("collect:cluster-a");
    expect(options.jobKeyMode).toBe("replace");
    expect(options.maxAttempts).toBe(5);
  });
});
