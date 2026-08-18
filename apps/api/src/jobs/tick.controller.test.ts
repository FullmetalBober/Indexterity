// Nest's route decorators write metadata at class-definition time, and this
// file constructs the controller directly rather than through Nest — the
// polyfill still has to exist before the class does.
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../config/env";
import { TickController } from "./tick.controller";
import type { TickService } from "./tick.service";

// The controller's job is routing between refusals, the bounded drain and the
// enqueue-only path — the tick itself is TickService's and tested there, so a
// fake stands in.
vi.mock("./tick.service", () => ({ TickService: class {} }));

const SECRET = "s".repeat(48);
const BASE = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  MASTER_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  BETTER_AUTH_SECRET: "unit-test-secret",
};

function load(flags: { runWorker: boolean; runCronjob: boolean }) {
  loadEnv("api", {
    ...BASE,
    RUN_WORKER: String(flags.runWorker),
    RUN_CRONJOB: String(flags.runCronjob),
    ...(flags.runCronjob ? {} : { CRON_TRIGGER_SECRET: SECRET }),
  });
}

function makeController(drained = false) {
  const service = {
    tickWithin: vi.fn(async () => ({
      dispatched: ["scheduleApply"],
      alreadyClaimed: ["scheduleProbe"],
      drained,
    })),
    enqueueDue: vi.fn(async () => ({ dispatched: ["digest"], alreadyClaimed: ["retention"] })),
  };
  return { controller: new TickController(service as unknown as TickService), service };
}

describe("POST /api/internal/tick", () => {
  // Two clocks may not coexist: while the in-process interval owns the
  // schedule, an external caller must be told so rather than obeyed.
  it("refuses while this deployment owns its own schedule", async () => {
    load({ runWorker: true, runCronjob: true });
    const { controller, service } = makeController();
    expect(await controller.tick(`Bearer ${SECRET}`)).toEqual({
      error: "this deployment owns its own schedule (RUN_CRONJOB=true)",
    });
    expect(service.tickWithin).not.toHaveBeenCalled();
    expect(service.enqueueDue).not.toHaveBeenCalled();
  });

  it("refuses a missing, malformed or wrong token without touching the tick", async () => {
    load({ runWorker: true, runCronjob: false });
    const { controller, service } = makeController();
    expect(await controller.tick(undefined)).toEqual({ error: "unauthorized" });
    expect(await controller.tick(SECRET)).toEqual({ error: "unauthorized" });
    expect(await controller.tick(`Bearer ${"w".repeat(48)}`)).toEqual({ error: "unauthorized" });
    expect(service.tickWithin).not.toHaveBeenCalled();
    expect(service.enqueueDue).not.toHaveBeenCalled();
  });

  // The process executes jobs and nothing LISTENs any more, so the request is
  // the drain — bounded, and honest about whether it finished.
  it("claims and drains when this process executes jobs", async () => {
    load({ runWorker: true, runCronjob: false });
    const { controller, service } = makeController(true);
    const body = await controller.tick(`Bearer ${SECRET}`);
    expect(body).toEqual({
      dispatched: ["scheduleApply"],
      alreadyClaimed: ["scheduleProbe"],
      drained: true,
    });
    // 25s, under the 30-60s platform proxy floors #226 measured.
    expect(service.tickWithin).toHaveBeenCalledWith(25_000);
    expect(service.enqueueDue).not.toHaveBeenCalled();
  });

  it("says drained:false when the deadline beat the drain, so the caller pings again", async () => {
    load({ runWorker: true, runCronjob: false });
    const { controller } = makeController(false);
    expect(await controller.tick(`Bearer ${SECRET}`)).toMatchObject({ drained: false });
  });

  // The standalone worker still holds its own LISTEN until #232, so enqueueing
  // is enough and the request stays millisecond-scale.
  it("only enqueues when a standalone worker executes jobs", async () => {
    load({ runWorker: false, runCronjob: false });
    const { controller, service } = makeController();
    const body = await controller.tick(`Bearer ${SECRET}`);
    expect(body).toEqual({ dispatched: ["digest"], alreadyClaimed: ["retention"] });
    expect("drained" in body).toBe(false);
    expect(service.tickWithin).not.toHaveBeenCalled();
    expect(service.enqueueDue).toHaveBeenCalledTimes(1);
  });
});
