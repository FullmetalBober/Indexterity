import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../config/env";
import type { DatabaseService } from "../db/database.service";
import { TICK_INTERVAL_MS, TickService } from "./tick.service";

// The drain, as something the tests can hold open. Each runOnce call parks
// until the test releases it, because every property worth testing here — the
// overlap guard, the deadline, shutdown — is about what happens WHILE a drain
// is in flight, and a drain that returns immediately has no while.
const worker = vi.hoisted(() => {
  const calls: {
    options: {
      pgPool: unknown;
      concurrency: number;
      events: EventEmitter;
      noHandleSignals: boolean;
    };
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  const runOnce = vi.fn(
    (options: (typeof calls)[number]["options"]) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ options, resolve: () => resolve(), reject });
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

vi.mock("graphile-worker", () => ({ runOnce: worker.runOnce }));
// The claim side has its own tests (burst.test.ts); here it only has to say
// what it dispatched so the outcome passthrough is observable.
vi.mock("./burst", () => ({
  claimDuePasses: vi.fn(async () => ({ dispatched: ["scheduleApply"], alreadyClaimed: [] })),
}));
vi.mock("./tasks", () => ({ createTaskList: vi.fn(() => ({})) }));
vi.mock("./runner", () => ({ wireRunnerEvents: vi.fn() }));
vi.mock("../errors/reporting", () => ({ captureError: vi.fn() }));

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

function makeService() {
  const pool = { label: "the api pool" };
  const database = { db: { execute: vi.fn() }, pool } as unknown as DatabaseService;
  return { service: new TickService(database), pool };
}

// Everything queued — microtasks and immediates — settled, without advancing
// any timer a test is holding.
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
    // graphile-worker's pool:create does.
    const gracefulShutdown = vi.fn().mockResolvedValue(undefined);
    worker.calls[0]?.options.events.emit("pool:create", { workerPool: { gracefulShutdown } });

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
