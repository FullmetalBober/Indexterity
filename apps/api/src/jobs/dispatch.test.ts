import { describe, expect, it, vi } from "vitest";
import { at, present } from "../errors/at";
import {
  type ClusterRoster,
  dispatchToAllClusters,
  enqueueClusterPass,
  type JobQueue,
  type RunningPasses,
} from "./dispatch";

const CLUSTERS = [{ id: "cluster-a" }, { id: "cluster-b" }];

// Which clusters have the pass running now. Nothing, unless a test says so.
function running(...ids: string[]): RunningPasses {
  return { locked: async () => new Set(ids) };
}
const idle = running();

// Handed in, not mocked out. This used to be a vi.mock of ./db replacing the
// module-level jobDb() the function reached for; now the database is an argument,
// so the fake is a value in the test rather than a rewritten import — which is
// the whole point of the change that moved it there.
// A roster, not a database. What the dispatcher needs is a list of ids, and
// saying so is what makes this fake plain enough to write without asserting
// past anything.
const roster: ClusterRoster = { ids: async () => CLUSTERS.map((cluster) => cluster.id) };
vi.mock("../metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metrics")>()),
  observeClusterFleet: () => undefined,
}));

function helpers() {
  // Typed to the port's own signature, so `spy.mock.calls` is a typed tuple and
  // the assertions below read `call[2]` without asserting anything about it.
  // Nothing reads what addJob RETURNS, and JobQueue says so, so it answers
  // undefined — there is no Job to fake either.
  const addJob = vi.fn<JobQueue["addJob"]>(async () => undefined);
  return {
    spy: addJob,
    // A complete JobQueue: both members implemented, nothing asserted away.
    helpers: {
      addJob,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  };
}

describe("dispatchToAllClusters", () => {
  it("enqueues the task once per cluster", async () => {
    const { spy, helpers: h } = helpers();
    await expect(dispatchToAllClusters(roster, "collect", h, idle)).resolves.toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((call) => call[1])).toEqual([
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
    await dispatchToAllClusters(roster, "collect", h, idle);

    const options = spy.mock.calls.map((call) => present(call[2], "the job options"));
    expect(options.map((o) => o.queueName)).toEqual(["collect:cluster-a", "collect:cluster-b"]);
    // Two clusters must NOT share a queue, or one slow cluster stalls the fleet.
    expect(new Set(options.map((o) => o.queueName)).size).toBe(2);
  });

  it("keys the queue by task as well, so a probe never waits behind a collect", async () => {
    const collect = helpers();
    const probe = helpers();
    await dispatchToAllClusters(roster, "collect", collect.helpers, idle);
    await dispatchToAllClusters(roster, "probe", probe.helpers, idle);

    const queueOf = (spy: ReturnType<typeof helpers>["spy"]) =>
      present(at(spy.mock.calls)[2], "the job options");
    expect(queueOf(collect.spy).queueName).toBe("collect:cluster-a");
    expect(queueOf(probe.spy).queueName).toBe("probe:cluster-a");
    // The five-minute probe must not queue behind a collect walking ten thousand
    // collections, so the two tasks are deliberately on different queues.
    expect(queueOf(collect.spy).queueName).not.toBe(queueOf(probe.spy).queueName);
  });

  it("still dedupes a pending job rather than piling them up", async () => {
    const { spy, helpers: h } = helpers();
    await dispatchToAllClusters(roster, "collect", h, idle);
    const options = present(at(spy.mock.calls)[2], "the job options");
    expect(options.jobKey).toBe("collect:cluster-a");
    expect(options.jobKeyMode).toBe("replace");
    expect(options.maxAttempts).toBe(5);
  });

  // #454. graphile-worker's add_jobs does more to a LOCKED job than clear its
  // key: it sets `attempts = max_attempts`, so a pass still running when its key
  // is re-added has spent every retry — it is not retried if it fails, and if
  // the worker dies under it the row sits dead with no error and no alert. The
  // running pass stands for this tick instead.
  it("stands down for a cluster whose pass is running, and queues the rest", async () => {
    const { spy, helpers: h } = helpers();
    await expect(dispatchToAllClusters(roster, "collect", h, running("cluster-a"))).resolves.toBe(
      1,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.map((call) => call[1])).toEqual([{ clusterId: "cluster-b" }]);
  });

  it("asks which passes are running once per dispatch, not once per cluster", async () => {
    const { helpers: h } = helpers();
    const locked = vi.fn(async () => new Set<string>());
    await dispatchToAllClusters(roster, "probe", h, { locked });
    expect(locked).toHaveBeenCalledTimes(1);
    expect(locked).toHaveBeenCalledWith("probe");
  });
});

// The collect-chained classify and suggest used to be `addJob(task, {clusterId})`
// with nothing else: no key, no queue, the library's twenty-five retries. They are
// enqueued the way the schedulers enqueue now, so a chased suggest dedupes against
// the hourly one instead of running beside it.
describe("enqueueClusterPass", () => {
  it("enqueues with the same key, queue and attempt cap as a dispatch", async () => {
    const { spy, helpers: h } = helpers();
    await expect(enqueueClusterPass(h, idle, "suggest", "cluster-a")).resolves.toBe(true);
    expect(present(at(spy.mock.calls)[2], "the job options")).toEqual({
      maxAttempts: 5,
      jobKey: "suggest:cluster-a",
      jobKeyMode: "replace",
      queueName: "suggest:cluster-a",
    });
  });

  it("adds nothing while that pass is running for the cluster", async () => {
    const { spy, helpers: h } = helpers();
    await expect(enqueueClusterPass(h, running("cluster-a"), "suggest", "cluster-a")).resolves.toBe(
      false,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
