import { beforeEach, describe, expect, it } from "vitest";
import { resetAlertCooldowns } from "../mail/notify";
import { UnsupportedServerError } from "../mongo/executor";
import { ClusterCredentialsError, ClusterGoneError } from "./cluster-connection";
import { type ClusterTaskDeps, runClusterTask } from "./tasks";

const CLUSTER = "11111111-1111-1111-1111-111111111111";

function recorder(): {
  deps: ClusterTaskDeps;
  warns: string[];
  errors: string[];
  alerts: string[];
  emitted: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  const alerts: string[] = [];
  const emitted: string[] = [];
  return {
    warns,
    errors,
    alerts,
    emitted,
    deps: {
      logger: {
        warn: (message) => void warns.push(message),
        error: (message) => void errors.push(message),
      },
      alertOwners: (clusterId, subject) => {
        alerts.push(`${clusterId}:${subject}`);
        return Promise.resolve();
      },
      emitPassFinished: (clusterId, task) => {
        emitted.push(`${clusterId}:${task}`);
        return Promise.resolve();
      },
    },
  };
}

function unreachable(): Error {
  return new Error("connect ECONNREFUSED 10.0.0.4:27017");
}

describe("runClusterTask", () => {
  beforeEach(() => {
    resetAlertCooldowns();
  });

  // Offboarding does not reach into the queue, so a deleted cluster's ticks
  // still run. Treating that as a failure costs three retries and a stack trace
  // per orphaned job, and alerts owners about a cluster they deleted.
  it("says nothing when the cluster was deleted before the tick ran", async () => {
    const log = recorder();
    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new ClusterGoneError(CLUSTER);
    });
    expect(log.warns).toHaveLength(0);
    expect(log.errors).toHaveLength(0);
    expect(log.alerts).toHaveLength(0);
  });

  it("passes a successful run straight through", async () => {
    const log = recorder();
    let ran = "";
    await runClusterTask("collect", CLUSTER, log.deps, async (id) => {
      ran = id;
    });
    expect(ran).toBe(CLUSTER);
    expect(log.warns).toHaveLength(0);
    expect(log.alerts).toHaveLength(0);
    // The landed pass is announced, so the dashboard can refetch what it wrote.
    expect(log.emitted).toEqual([`${CLUSTER}:collect`]);
  });

  it("announces nothing for a tick that changed nothing", async () => {
    const log = recorder();
    await runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(unreachable()));
    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new ClusterGoneError(CLUSTER);
    });
    expect(log.emitted).toHaveLength(0);
  });

  it("swallows an unreachable cluster and alerts the owners once", async () => {
    const log = recorder();
    // Three ticks of a cluster that has been down all day.
    for (let i = 0; i < 3; i++) {
      await expect(
        runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(unreachable())),
      ).resolves.toBeUndefined();
    }
    expect(log.warns).toHaveLength(3);
    expect(log.warns[0]).toContain("unreachable");
    // The cooldown means one email, not one per tick.
    expect(log.alerts).toEqual([`${CLUSTER}:collect skipped — cluster unreachable`]);
  });

  it("keeps the alert cooldown per cluster and per task", async () => {
    const log = recorder();
    const other = "22222222-2222-2222-2222-222222222222";
    await runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(unreachable()));
    await runClusterTask("finalize", CLUSTER, log.deps, () => Promise.reject(unreachable()));
    await runClusterTask("collect", other, log.deps, () => Promise.reject(unreachable()));
    expect(log.alerts).toHaveLength(3);
  });

  it("logs undecryptable credentials without emailing the customer", async () => {
    const log = recorder();
    await expect(
      runClusterTask("apply", CLUSTER, log.deps, () =>
        Promise.reject(new ClusterCredentialsError(CLUSTER, 2, new Error("invalid tag"))),
      ),
    ).resolves.toBeUndefined();
    expect(log.errors[0]).toContain("MASTER_KEY_V2");
    expect(log.alerts).toHaveLength(0);
  });

  it("still throws on a real bug, so the job retries and surfaces", async () => {
    const log = recorder();
    await expect(
      runClusterTask("finalize", CLUSTER, log.deps, () =>
        Promise.reject(new TypeError("cannot read properties of undefined")),
      ),
    ).rejects.toThrow(TypeError);
    expect(log.warns).toHaveLength(0);
  });

  it("reports an unsupported server once a day and does not retry it", async () => {
    const log = recorder();
    const tooOld = new UnsupportedServerError("MongoDB 4.2.24 cannot hide indexes");
    for (let i = 0; i < 3; i++) {
      await expect(
        runClusterTask("apply", CLUSTER, log.deps, () => Promise.reject(tooOld)),
      ).resolves.toBeUndefined();
    }
    expect(log.warns).toHaveLength(3);
    expect(log.alerts).toEqual([`${CLUSTER}:cluster version not supported`]);
  });
});
