import { EventEmitter } from "node:events";
import type { RunnerOptions, WorkerPool } from "graphile-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../config/env";
import { createDatabase } from "../db/client";
import { present } from "../errors/at";
import type { BurstResult } from "./burst";
import type { ClusterPasses } from "./cluster-tasks.service";
import { TASK_NAMES } from "./tasks";
import type { TickDatabase } from "./tick.service";
import { TICK_INTERVAL_MS, TickService } from "./tick.service";

// The drain, as something the tests can hold open. Each runOnce call parks
// until the test releases it, because every property worth testing here — the
// overlap guard, the deadline, shutdown — is about what happens WHILE a drain
// is in flight, and a drain that returns immediately has no while.
const worker = vi.hoisted(() => {
  const calls: {
    // The vendor's own options type rather than the four fields the assertions
    // read. A double declaring a NARROWER parameter is not the function it
    // stands in for — graphile-worker calls this with everything.
    options: RunnerOptions;
    // The same emitter, held as the node EventEmitter it is. `pool:create`'s
    // typed payload carries a plugin context that the listener under test never
    // reads and that cannot be built without three more vendor types, so the
    // announcement below goes through the base emit. What it announces IS a
    // complete WorkerPool.
    events: EventEmitter;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  const runOnce = vi.fn(
    (options: RunnerOptions) =>
      new Promise<void>((resolve, reject) => {
        const events = options.events;
        if (events === undefined) throw new Error("the tick must pass a shared emitter");
        calls.push({ options, events, resolve: () => resolve(), reject });
      }),
  );
  return {
    calls,
    runOnce,
    reset: () => {
      calls.length = 0;
      runOnce.mockClear();
    },
  };
});

vi.mock("graphile-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("graphile-worker")>()),
  runOnce: worker.runOnce,
}));
// The claim side has its own tests (burst.test.ts); here it only has to say
// what it dispatched so the outcome passthrough is observable.
vi.mock("./burst", (): typeof import("./burst") => ({
  claimDuePasses: vi.fn(
    async (): Promise<BurstResult> => ({ dispatched: ["scheduleApply"], alreadyClaimed: [] }),
  ),
  // The adapter that turns the database into the two statements a claim needs.
  // Mocked with the module because claimDuePasses is: what it returns is only
  // ever handed to the mock above.
  dbPassClaims: vi.fn(() => ({
    watermarks: async () => [],
    claim: async () => true,
  })),
}));
// The registry's KEYS are what the drain reads, so the double answers a task
// per name rather than an empty object — which the module type now insists on.
vi.mock("./tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tasks")>()),
  createTaskList: vi.fn(() =>
    Object.fromEntries(TASK_NAMES.map((name) => [name, () => Promise.resolve()])),
  ),
}));
vi.mock("./runner", (): typeof import("./runner") => ({ wireRunnerEvents: vi.fn() }));
vi.mock("../errors/reporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../errors/reporting")>()),
  captureError: vi.fn(),
}));
// The stale-lock repair every tick performs reaches postgres twice — a watermark
// claim and two statements — and this suite's database is a stub carrying
// `execute` and nothing else. Unmocked, `claimWatermark` threw on the missing
// `db.insert`, `drainOnce` caught it as designed, and the tick logged
//
//   ERROR [TickService] releasing stale locks failed: db.insert is not a function
//
// inside a PASSING test. Noise in a green run is worse than it looks: it is the
// shape a real failure would arrive in, so it trains the reader to skim past one.
//
// Mocked rather than taught to the stub, because what this suite pins is the
// overlap guard, the deadline and shutdown — whether the repair's SQL is right
// belongs to locks.ts and watermark.ts. The claim is granted and there is nothing
// to free, so `releaseLocks` runs end to end and reports nothing, which is the
// ordinary case on every tick after the first.
//
// importOriginal, not a bare object: tick.service.ts also imports `passKey` from
// this module and a factory that dropped it would break the import rather than
// the test.
vi.mock("./watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./watermark")>()),
  claimWatermark: vi.fn(async () => true),
}));
vi.mock("./locks", (): typeof import("./locks") => ({ releaseStaleLocks: vi.fn(async () => []) }));

const BASE = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  MASTER_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  BETTER_AUTH_SECRET: "unit-test-secret",
};

function load(flags: { runCronjob: boolean }, extra: Record<string, string> = {}) {
  loadEnv("api", {
    ...BASE,
    RUN_CRONJOB: String(flags.runCronjob),
    ...(flags.runCronjob ? {} : { CRON_TRIGGER_SECRET: "s".repeat(48) }),
    ...extra,
  });
}

// A syntactically valid URL nothing dials: the pool is never asked to connect.
const UNUSED_URL = "postgres://unused:unused@127.0.0.1:1/unused";

function makeService() {
  // The pool is only ever compared by identity — the service hands it to
  // runOnce and the assertions check it got THAT one — so a stub of the real Pool
  // says that more honestly than an object with a label on it.
  // Real objects, not stubs of them, and the reason is the same for both:
  // neither a pg Pool nor a drizzle client opens a connection until something
  // queries it. Verified rather than assumed — `new Pool(...)` and
  // `createDatabase(...)` both return with `totalCount` 0 and no socket — so
  // constructing them costs nothing and claims nothing.
  //
  // Which means this object is a whole DatabaseService rather than a partial
  // one: `db` and `pool` are the real things, and `rows` is the one member the
  // tested path answers for. Nothing here is asserted away.
  const db = createDatabase(UNUSED_URL, 1);
  const pool = db.$client;
  const database: TickDatabase = {
    db,
    pool,
    rows: async <TRow>(): Promise<TRow[]> => [],
  };
  // All six passes, implemented — not `{} as ClusterTasksService`, which is a
  // claim an empty object is a service and was the last one of those left here.
  //
  // `ClusterPasses` rather than the class: the service also carries five private
  // members, and a private field makes a class NOMINALLY typed — no object
  // literal can satisfy it however complete. The interface is both narrower and
  // the only one of the two a test can actually implement.
  //
  // What implementing it buys is the failure message. This suite never
  // runs a pass — it drives the tick's claim/drain arithmetic — so each of these
  // SAYS it was not expected rather than being absent, and a test that starts
  // reaching one gets a sentence instead of `undefined is not a function`.
  const notRun = (pass: string) => () =>
    Promise.reject(new Error(`the ${pass} pass is not exercised by this suite`));
  const clusterTasks: ClusterPasses = {
    collect: notRun("collect"),
    classify: notRun("classify"),
    suggest: notRun("suggest"),
    apply: notRun("apply"),
    finalize: notRun("finalize"),
    probe: notRun("probe"),
  };
  return { service: new TickService(database, clusterTasks), pool };
}

// Everything queued — microtasks and immediates — settled, without advancing
// any timer a test is holding.
// Everything a WorkerPool is, so the emit below states the vendor's own payload
// rather than a fragment of it. Only `gracefulShutdown` is reachable from this
// test; the others say so by throwing, and the compiler keeps the list complete
// across a graphile-worker upgrade.
function workerPool(gracefulShutdown: WorkerPool["gracefulShutdown"]): WorkerPool {
  const unused = (member: string): never => {
    throw new Error(`WorkerPool.${member} is not used by these tests`);
  };
  // Built ON a resolved promise rather than declaring `then`/`catch`/`finally`:
  // a WorkerPool is awaitable, and a hand-written `then` that throws would be a
  // hostile thenable for anything that awaited it (biome says so too).
  return Object.assign(Promise.resolve(), {
    gracefulShutdown,
    id: "test-pool",
    nudge: () => unused("nudge"),
    release: () => unused("release"),
    forcefulShutdown: () => unused("forcefulShutdown"),
    promise: Promise.resolve(),
    abortSignal: AbortSignal.abort(),
    abortPromise: Promise.resolve(),
    _shuttingDown: false,
    _forcefulShuttingDown: false,
    _active: true,
    _workers: [],
    _withPgClient: () => unused("_withPgClient"),
    _start: null,
    worker: null,
  });
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  worker.reset();
  vi.useRealTimers();
});

describe("the overlap guard", () => {
  // The must-not-get-wrong of #231: the watermark protects dispatch, so this
  // guard is the ONLY thing between two triggers and two concurrent runOnce
  // calls against the same pool.
  it("serialises a tick that arrives while a drain is in flight", async () => {
    load({ runCronjob: true });
    const { service } = makeService();

    const first = service.tick();
    await settle();
    expect(worker.calls.length).toBe(1);

    // A second trigger mid-drain: its claim runs (idempotent, cheap), its
    // drain must wait.
    const second = service.tick();
    await settle();
    expect(worker.calls.length).toBe(1);

    worker.calls[0]?.resolve();
    await settle();
    expect(worker.calls.length).toBe(2);

    worker.calls[1]?.resolve();
    await expect(first).resolves.toMatchObject({ drained: true, dispatched: ["scheduleApply"] });
    await expect(second).resolves.toMatchObject({ drained: true });
  });

  it("keeps later ticks alive after a drain that failed", async () => {
    load({ runCronjob: true });
    const { service } = makeService();

    const failing = service.tick();
    await settle();
    worker.calls[0]?.reject(new Error("postgres went away"));
    await expect(failing).rejects.toThrow("postgres went away");

    // The chain must have swallowed the failure for ITSELF only — the next
    // tick still runs rather than inheriting the rejection.
    const next = service.tick();
    await settle();
    expect(worker.calls.length).toBe(2);
    worker.calls[1]?.resolve();
    await expect(next).resolves.toMatchObject({ drained: true });
  });
});

describe("the bounded tick", () => {
  it("answers drained:false at the deadline and lets the drain carry on", async () => {
    load({ runCronjob: false });
    const { service } = makeService();

    const outcome = await service.tickWithin(20);
    expect(outcome).toEqual({
      dispatched: ["scheduleApply"],
      alreadyClaimed: [],
      drained: false,
    });
    // The drain was started and is still running — the deadline abandoned the
    // wait, not the work.
    expect(worker.calls.length).toBe(1);
    worker.calls[0]?.resolve();
    await settle();
  });

  it("answers drained:true when the drain beats the deadline", async () => {
    load({ runCronjob: false });
    const { service } = makeService();

    const outcome = service.tickWithin(5_000);
    await settle();
    worker.calls[0]?.resolve();
    await expect(outcome).resolves.toMatchObject({ drained: true });
  });
});

describe("the drain's runOnce options", () => {
  it("hands runOnce the api's own pool, no signal handlers, and a capped concurrency", async () => {
    // PG_POOL_MAX 3 with WORKER_CONCURRENCY 4: the pool is the binding
    // constraint, so the drain gets 3 - 1 = 2 — never the whole pool.
    load({ runCronjob: true }, { WORKER_CONCURRENCY: "4", PG_POOL_MAX: "3" });
    const { service, pool } = makeService();

    const tick = service.tick();
    await settle();
    const options = worker.calls[0]?.options;
    expect(options?.pgPool).toBe(pool);
    expect(options?.noHandleSignals).toBe(true);
    expect(options?.concurrency).toBe(2);
    worker.calls[0]?.resolve();
    await tick;
  });
});

describe("the in-process interval", () => {
  // Trigger 1 exists only when this process owns the schedule; RUN_CRONJOB=false
  // hands the clock to the HTTP tick and nothing here may fire on its own.
  it("does not start when the clock is external (RUN_CRONJOB=false)", () => {
    load({ runCronjob: false });
    const { service } = makeService();
    expect(service.startInterval()).toBe(false);
    expect(worker.runOnce).not.toHaveBeenCalled();
  });

  it("ticks once at boot and again every interval", async () => {
    vi.useFakeTimers();
    load({ runCronjob: true });
    const { service } = makeService();

    expect(service.startInterval()).toBe(true);
    // The boot tick — a fresh install collects now, not in thirty seconds.
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.runOnce).toHaveBeenCalledTimes(1);
    worker.calls[0]?.resolve();

    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(worker.runOnce).toHaveBeenCalledTimes(2);
    worker.calls[1]?.resolve();

    await service.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(10 * TICK_INTERVAL_MS);
    expect(worker.runOnce).toHaveBeenCalledTimes(2);
  });
});

describe("shutdown", () => {
  it("asks the in-flight drain to stop and waits for it before returning", async () => {
    load({ runCronjob: true });
    const { service } = makeService();

    const tick = service.tick();
    await settle();
    expect(worker.calls.length).toBe(1);

    // The pool announces itself on the shared emitter, exactly as
    // graphile-worker's pool:create does — and with a COMPLETE WorkerPool,
    // because the event's payload type is the vendor's. The rest refuses: what
    // this test says is that shutdown reaches gracefulShutdown and nothing else.
    const gracefulShutdown = vi.fn().mockResolvedValue(undefined);
    present(worker.calls[0], "a drain to announce a pool on").events.emit("pool:create", {
      workerPool: workerPool(gracefulShutdown),
    });

    let closed = false;
    const shutdown = service.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    await settle();
    expect(gracefulShutdown).toHaveBeenCalled();
    // The drain has not settled, so neither may shutdown — this is the whole
    // guarantee that DatabaseService's later phase cannot drain the pool out
    // from under a running job (D71).
    expect(closed).toBe(false);

    worker.calls[0]?.resolve();
    await shutdown;
    expect(closed).toBe(true);
    await expect(tick).resolves.toMatchObject({ drained: true });
  });

  it("refuses to start a fresh drain once shutdown has begun", async () => {
    load({ runCronjob: true });
    const { service } = makeService();

    await service.beforeApplicationShutdown();
    const late = await service.tick();
    expect(late.drained).toBe(false);
    expect(worker.runOnce).not.toHaveBeenCalled();
  });
});
