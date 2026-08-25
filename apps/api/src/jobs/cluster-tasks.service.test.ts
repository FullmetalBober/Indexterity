import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../db/database.service";
import type { NotifyService } from "../mail/notify.service";
import { applyCluster } from "./apply";
import { settleBuildsForCluster } from "./building";
import { refreshInferredWindow } from "./change-window";
import { classifyCluster } from "./classify";
import { ClusterGoneError } from "./cluster-connection";
import { ClusterTasksService } from "./cluster-tasks.service";
import { collectCluster } from "./collect";
import { applyCreatesForCluster } from "./create";
import { probeCluster } from "./probe";

// The passes themselves are tested where they live. What is untested — and what a
// registry refactor can silently break — is which pass each queue name runs and
// what it enqueues afterwards, so that is what this pins.
vi.mock("./collect", () => ({ collectCluster: vi.fn() }));
vi.mock("./classify", () => ({ classifyCluster: vi.fn() }));
vi.mock("./change-window", () => ({ refreshInferredWindow: vi.fn() }));
vi.mock("./suggest", () => ({ suggestForCluster: vi.fn() }));
vi.mock("./apply", () => ({ applyCluster: vi.fn() }));
vi.mock("./building", () => ({ settleBuildsForCluster: vi.fn() }));
vi.mock("./create", () => ({ applyCreatesForCluster: vi.fn() }));
vi.mock("./finalize", () => ({ finalizeCluster: vi.fn() }));
vi.mock("./probe", () => ({ probeCluster: vi.fn(async () => []) }));
vi.mock("../events/emit", () => ({ emitPassFinished: vi.fn() }));
vi.mock("../mail/notify", () => ({
  ALERT_COOLDOWN_MS: 1,
  alertAllowed: vi.fn(async () => false),
}));

const CLUSTER = "11111111-1111-1111-1111-111111111111";

function service() {
  const db = {} as DatabaseService["db"];
  return new ClusterTasksService(
    { db } as unknown as DatabaseService,
    { notifyClusterOwners: vi.fn() } as unknown as NotifyService,
  );
}

function helpers() {
  return {
    addJob: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Parameters<ClusterTasksService["collect"]>[1] & {
    addJob: ReturnType<typeof vi.fn>;
    logger: { info: ReturnType<typeof vi.fn> };
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the per-cluster passes", () => {
  it("runs the collect and then chases it with classify and suggest", async () => {
    const help = helpers();
    await service().collect({ clusterId: CLUSTER }, help);

    expect(collectCluster).toHaveBeenCalledWith({}, CLUSTER);
    expect(help.addJob.mock.calls.map((call) => call[0])).toEqual(["classify", "suggest"]);
  });

  // Nothing is chased when the collect itself did not land: the enqueue happens
  // inside the pass, so a failure that the decision table survives leaves the
  // queue alone rather than re-deriving yesterday's answer.
  it("enqueues nothing when the collect throws something survivable", async () => {
    vi.mocked(collectCluster).mockRejectedValueOnce(new ClusterGoneError(CLUSTER));
    const help = helpers();
    await service().collect({ clusterId: CLUSTER }, help);
    expect(help.addJob).not.toHaveBeenCalled();
  });

  it("re-derives the change window in the same pass as the classify", async () => {
    await service().classify({ clusterId: CLUSTER }, helpers());
    expect(classifyCluster).toHaveBeenCalledWith({}, CLUSTER);
    expect(refreshInferredWindow).toHaveBeenCalledWith({}, CLUSTER);
  });

  // Order is the assertion, not just the calls: a build asked for on an earlier
  // tick has to finish before this pass decides anything new (#332).
  it("settles builds before it applies anything", async () => {
    const order: string[] = [];
    // Each answers with the count of what it did, so the fakes return 0 rather
    // than void — a real signature the static imports enforce and the
    // `await import` these used to do did not.
    vi.mocked(settleBuildsForCluster).mockImplementationOnce(async () => {
      order.push("settle");
      return 0;
    });
    vi.mocked(applyCluster).mockImplementationOnce(async () => {
      order.push("apply");
      return 0;
    });
    vi.mocked(applyCreatesForCluster).mockImplementationOnce(async () => {
      order.push("create");
      return 0;
    });
    await service().apply({ clusterId: CLUSTER }, helpers());
    expect(order).toEqual(["settle", "apply", "create"]);
  });

  it("asks for a suggest only when the probe found something", async () => {
    const quiet = helpers();
    await service().probe({ clusterId: CLUSTER }, quiet);
    expect(quiet.addJob).not.toHaveBeenCalled();

    vi.mocked(probeCluster).mockResolvedValueOnce([
      { database: "app", collection: "orders", reason: "reads up 4x" },
    ] as Awaited<ReturnType<typeof probeCluster>>);
    const loud = helpers();
    await service().probe({ clusterId: CLUSTER }, loud);
    expect(loud.addJob).toHaveBeenCalledWith("suggest", { clusterId: CLUSTER });
    expect(loud.logger.info).toHaveBeenCalledOnce();
  });
});
