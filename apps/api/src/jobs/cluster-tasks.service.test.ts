import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/client";
import { TunnelRegistry } from "../tunnel/tunnel.registry";
import { applyCluster } from "./apply";
import { settleBuildsForCluster } from "./building";
import { refreshInferredWindow } from "./change-window";
import { classifyCluster } from "./classify";
import { ClusterGoneError } from "./cluster-connection";
import { ClusterTasksService } from "./cluster-tasks.service";
import { collectCluster } from "./collect";
import { applyCreatesForCluster } from "./create";
import type { JobQueue } from "./dispatch";
import { probeCluster } from "./probe";
import { suggestForCluster } from "./suggest";

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
// Why the pipeline stopped is written to the clusters row, and this suite's db is
// an empty object: what it pins is which pass each queue name runs, not what a
// pass records about itself (tasks.test.ts owns that).
vi.mock("./blocked", () => ({ markBlocked: vi.fn(), markUnblocked: vi.fn() }));
vi.mock("../events/emit", () => ({ emitPassFinished: vi.fn(), pgNotifier: vi.fn() }));
vi.mock("../mail/notify", () => ({
  ALERT_COOLDOWN_MS: 1,
  alertAllowed: vi.fn(async () => false),
}));

const CLUSTER = "11111111-1111-1111-1111-111111111111";

// A REAL drizzle client, not `{} as DatabaseService["db"]`. It opens no
// connection until something queries it — measured: `totalCount` 0 and no
// socket — and every pass below is mocked, so nothing ever does. Shared, so the
// assertions can name the object the service was actually handed.
const db = createDatabase("postgres://unused:unused@127.0.0.1:1/unused", 1);

function service() {
  return new ClusterTasksService(
    { db },
    // A complete OwnerAlerts: one method, implemented.
    { notifyClusterOwners: vi.fn() },
    // A real registry with no tunnels in it: these tests are about what a task
    // does with a failure, and no cluster here has a tunnel_id.
    new TunnelRegistry(),
  );
}

// The real JobHelpers, plus the two members the assertions reach for. Named
// rather than inline so `stub` has something to check the literal against.
// A complete JobQueue, plus the mock handles the assertions read back off it.
// No `stub` and no fake Job: nothing reads what addJob returns, and the port
// says so.
type Helpers = JobQueue & {
  addJob: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn> };
};

function helpers(): Helpers {
  return {
    addJob: vi.fn(async () => undefined),
    logger: {
      info: vi.fn((_message: string) => undefined),
      warn: vi.fn((_message: string) => undefined),
      error: vi.fn((_message: string) => undefined),
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the per-cluster passes", () => {
  it("runs the collect and then chases it with classify and suggest", async () => {
    const help = helpers();
    await service().collect({ clusterId: CLUSTER }, help);

    // The third argument is the point of the change: the registry is handed
    // DOWN from the one place the container reaches, rather than the pipeline
    // reaching sideways for a module global.
    expect(collectCluster).toHaveBeenCalledWith(db, CLUSTER, expect.any(TunnelRegistry));
    expect(help.addJob.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "classify",
      "suggest",
    ]);
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
    expect(classifyCluster).toHaveBeenCalledWith(db, CLUSTER);
    expect(refreshInferredWindow).toHaveBeenCalledWith(db, CLUSTER);
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

  // #407, and the bug that fix nearly shipped with.
  //
  // `suggest` can build an index — instant apply (D7) — and it also has a
  // wall-clock budget, which no build may ever be cut off by. Abandoning the
  // pass does not stop the index being built; it only stops us recording it,
  // taking its write-latency baseline and moving it to ACTIVE. So the budget
  // covers the analysis and the build sits outside it.
  it("still builds the instant-approved creates after the analysis", async () => {
    vi.mocked(suggestForCluster).mockResolvedValue({ created: 2, instantApproved: 2 });

    await service().suggest({ clusterId: CLUSTER }, helpers());

    expect(applyCreatesForCluster).toHaveBeenCalledWith(expect.anything(), CLUSTER);
  });

  // And it must not run one when nothing was auto-approved, which is the
  // ordinary case: a build is a write to somebody's production database, so it
  // happens because something asked for it and never just in passing.
  it("builds nothing when the analysis approved nothing instantly", async () => {
    vi.mocked(suggestForCluster).mockResolvedValue({ created: 5, instantApproved: 0 });

    await service().suggest({ clusterId: CLUSTER }, helpers());

    expect(applyCreatesForCluster).not.toHaveBeenCalled();
  });

  it("asks for a suggest only when the probe found something", async () => {
    const quiet = helpers();
    await service().probe({ clusterId: CLUSTER }, quiet);
    expect(quiet.addJob).not.toHaveBeenCalled();

    const found: Awaited<ReturnType<typeof probeCluster>> = [
      { database: "app", collection: "orders", reason: "reads up 4x" },
    ];
    vi.mocked(probeCluster).mockResolvedValueOnce(found);
    const loud = helpers();
    await service().probe({ clusterId: CLUSTER }, loud);
    expect(loud.addJob).toHaveBeenCalledWith("suggest", { clusterId: CLUSTER });
    expect(loud.logger.info).toHaveBeenCalledOnce();
  });
});
