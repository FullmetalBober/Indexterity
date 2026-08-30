import { EventEmitter } from "node:events";
import { type BeforeApplicationShutdown, Inject, Injectable, Logger } from "@nestjs/common";
import { runOnce, type WorkerEvents, type WorkerPool } from "graphile-worker";
import { apiEnv, workerEnv } from "../config/env";
import { sql } from "../db";
import { DatabaseService } from "../db/database.service";
import { captureError } from "../errors/reporting";
import { type BurstResult, claimDuePasses } from "./burst";
import { ClusterTasksService } from "./cluster-tasks.service";
import { releaseStaleLocks } from "./locks";
import { wireRunnerEvents } from "./runner";
import { everyMinutes } from "./schedule";
import { createTaskList } from "./tasks";
import { claimWatermark, passKey } from "./watermark";

// How often the in-process clock ticks, when this process owns the schedule.
//
// Thirty seconds, and the number is bounded from both sides. The tightest pass
// in BURST_SCHEDULE is five minutes, and the occurrence arithmetic does the
// actual timing — the timer only has to be finer-grained than the tightest
// bucket, so anything under a minute or two changes nothing about the schedule.
// What sets the floor is user-visible latency: with no resident runner there is
// no `LISTEN "jobs:insert"` any more, so the dashboard's collect button waits
// for the next drain instead of starting at once (#229, risk 3), and this
// interval IS that worst-case wait. Thirty seconds keeps a click's "nothing
// happened yet" under the threshold where people re-click, while an idle tick
// costs one watermark read and one empty getJob — cheap enough to pay 2,880
// times a day.
export const TICK_INTERVAL_MS = 30_000;

// The stale-lock reset's own cadence, claimed through worker_watermarks like a
// pass so replicas do not duplicate it. Five minutes because the reset only
// forgives locks four hours old — running it oftener buys nothing, and the
// five-minute grid already exists for scheduleApply and scheduleProbe.
const RESET_LOCKS_PASS = "resetLocks";
const RESET_LOCKS_MINUTES = 5;

// One tick, reported honestly: what this call enqueued, what another tick beat
// it to, and whether the queue was actually drained afterwards — false means
// the caller's deadline expired first (or shutdown intervened) and a re-tick
// will resume, which the occurrence claims and job keys make free.
//
// `drained: true` means the drain ran to completion, and NOT that the jobs table
// is empty at the instant this returns. graphile-worker's worker fires
// `completeJob(job)` without awaiting it and goes straight back to polling, so
// the pool can resolve with the last job's DELETE still in flight — measured at
// 24 of 25 rounds (#280). The row is locked and its attempt is spent, so nothing
// claims it twice; it simply disappears a few milliseconds late.
export interface TickOutcome {
  readonly dispatched: readonly string[];
  readonly alreadyClaimed: readonly string[];
  readonly drained: boolean;
}

// The tick function of #229/#231: work out what became due, enqueue it, drain
// the queue with runOnce, all inside the api process. Two triggers share it —
// the in-process interval (startInterval, when RUN_CRONJOB is true) and GET
// /api/internal/tick (tick.controller.ts, when the clock is external). Since
// #232 this is the pipeline's ONLY host: runOnce never opens `LISTEN
// "jobs:insert"` (that lives in graphile-worker's run() path, verified in
// dist/main.js), so an api with nothing to do holds no job machinery at all.
//
// runOnce drains work enqueued DURING its own run, to any depth — measured in
// #212 against postgres 17 with graphile-worker 0.17.3 — which is what makes a
// single drain per tick enough: the tick enqueues the scheduler passes, those
// fan out per cluster, and the same drain executes the lot.
/**
 * The three members the tick uses of the database service.
 *
 * Not a big narrowing — the service has four — but it is the difference between
 * a test object that IS this and one that claims to be a DatabaseService while
 * implementing part of it. `onApplicationShutdown` is the one left out, and the
 * tick has no business calling it.
 */
export interface TickDatabase {
  db: DatabaseService["db"];
  pool: DatabaseService["pool"];
  rows: DatabaseService["rows"];
}

@Injectable()
export class TickService implements BeforeApplicationShutdown {
  private readonly log = new Logger(TickService.name);
  // ONE emitter for every drain this process ever runs, wired once: runOnce
  // accepts `events` (RunnerOptions inherits it from SharedOptions) and the
  // workers emit job:success/job:error/job:failed on exactly this stream, so
  // the dead-letter capture, the owner alerts and the job counters survive the
  // resident runner's removal. Re-wiring per drain would stack handlers and
  // report every failure N times.
  private readonly events = new EventEmitter() as WorkerEvents;
  private readonly taskList: ReturnType<typeof createTaskList>;
  // The overlap guard (#231, must-not-get-wrong 1). The watermark claims
  // protect DISPATCH only — two concurrent runOnce calls are otherwise legal
  // and would double every pool cost — so drains are serialised through this
  // chain: a tick that arrives mid-drain queues its drain behind the in-flight
  // one. The claims are occurrence-idempotent, so the claim side needs no
  // guard, and the queued drain usually finds an empty queue — one cheap query.
  private drainChain: Promise<unknown> = Promise.resolve();
  // The pool of the drain currently in flight, captured from the public
  // pool:create event so shutdown can ask it to stop without reaching into
  // graphile-worker internals.
  private activePool: WorkerPool | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    @Inject(DatabaseService) private readonly database: TickDatabase,
    clusterTasks: ClusterTasksService,
  ) {
    this.taskList = createTaskList(database.db, clusterTasks);
    this.events.on("pool:create", ({ workerPool }) => {
      this.activePool = workerPool;
    });
    // Unconditional since #232: with the standalone worker gone, this process
    // is the only thing that executes jobs, so it is always the one that must
    // answer for the dead-letter capture, the owner alerts and the counters.
    wireRunnerEvents(database.db, this.events);
  }

  // Trigger 1: the in-process clock, on when this process owns the schedule
  // (RUN_CRONJOB=false hands the clock to GET /api/internal/tick instead).
  // Deliberately a plain setInterval and not @nestjs/schedule — what that
  // dependency adds is cron EXPRESSIONS, which is exactly the work duePasses
  // already replaced with occurrence arithmetic (#229). Returns whether it
  // started, so main.ts can log one honest line.
  startInterval(): boolean {
    if (!apiEnv().RUN_CRONJOB) return false;
    // One tick immediately, not in thirty seconds: a fresh install must collect
    // now (its first impression is an empty dashboard until it does), and a
    // host that slept owes exactly one occurrence per pass — claimDuePasses
    // computes that, so the boot tick is also the catch-up tick.
    void this.tick().catch((error) => this.reportTickFailure(error));
    this.interval = setInterval(() => {
      void this.tick().catch((error) => this.reportTickFailure(error));
    }, TICK_INTERVAL_MS);
    return true;
  }

  // The whole tick: claim and enqueue what became due, then drain to empty.
  async tick(now: Date = new Date()): Promise<TickOutcome> {
    const claim = await this.enqueueDue(now);
    const drained = await this.drainSerialized();
    return { ...claim, drained };
  }

  // The bounded tick, for the HTTP trigger: same claim, same serialised drain,
  // but the caller gets an answer at `deadlineMs` even if the drain is still
  // going. runOnce accepts no abortSignal (nothing in the RunnerOptions chain
  // does), so the drain cannot be cancelled — it is RACED: past the deadline
  // the response says drained:false and the drain carries on in-process, which
  // a re-tick resumes rather than duplicates.
  async tickWithin(deadlineMs: number, now: Date = new Date()): Promise<TickOutcome> {
    const claim = await this.enqueueDue(now);
    const drain = this.drainSerialized();
    const drained = await raceDeadline(drain, deadlineMs);
    if (drained === null) {
      // The response is gone, so this promise has no awaiter left — a failure
      // after the deadline must still land somewhere visible.
      drain.catch((error) => this.reportTickFailure(error));
      return { ...claim, drained: false };
    }
    return { ...claim, drained };
  }

  // Claim-then-enqueue, through the pool this process already holds. The job
  // key guards the window between claiming a pass and this insert landing — a
  // tick that claimed and then died leaves a pending job the next tick must not
  // duplicate — and preserve_run_at keeps a re-key from bumping the schedule.
  private async enqueueDue(now: Date = new Date()): Promise<BurstResult> {
    return claimDuePasses(
      this.database.db,
      (task) =>
        this.database.rows(
          sql`select graphile_worker.add_job(
                ${task}::text,
                job_key => ${`tick:${task}`}::text,
                job_key_mode => 'preserve_run_at')`,
        ),
      now,
    );
  }

  // Stopping (#231, must-not-get-wrong 2), in the beforeApplicationShutdown
  // PHASE on purpose. Nest's close() runs the phases strictly in order —
  // onModuleDestroy, then beforeApplicationShutdown, then onApplicationShutdown
  // — but WITHIN a phase it fires every provider's hook under one Promise.all
  // (verified in @nestjs/core hooks/on-app-shutdown.hook.js), so "TickService
  // injects DatabaseService" orders their construction and NOT their teardown.
  // Settling the drain a whole phase before DatabaseService drains the pool in
  // onApplicationShutdown is what actually keeps closed the race D71 closed:
  // the pool cannot be pulled out from under a running job.
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Ask the in-flight drain to stop: gracefulShutdown stops the workers
    // taking new jobs and lets the running ones finish (their helpers get an
    // abort signal after graphile-worker's 5s default). Jobs left in the queue
    // are exactly what the next boot's first tick exists to resume.
    try {
      await this.activePool?.gracefulShutdown("api shutting down");
    } catch {
      // The pool may have finished between the null check and the call, or
      // already be shutting down — either way the wait below is the guarantee.
    }
    await this.drainChain;
  }

  private drainSerialized(): Promise<boolean> {
    const next = this.drainChain.then(() => this.drainOnce());
    // The chain must survive a failed drain — a rejected tail would reject
    // every later tick before it ran — so the tail swallows what the caller's
    // copy of `next` still reports.
    this.drainChain = next.catch(() => undefined);
    return next;
  }

  // Free anything a dead worker is still holding, before the drain tries to
  // claim it (#253). This is NOT a queued pass: the thing it repairs is the
  // queue, so putting the repair inside the queue would leave it one drain
  // behind at best and unreachable at worst. It is claimed on the same
  // five-minute occurrence arithmetic a pass uses, which is what keeps two
  // replicas from both running it, and it is deliberately not fatal — a tick
  // that cannot reset locks must still drain the queues that are not stuck.
  private async releaseLocks(now: Date): Promise<void> {
    const claimed = await claimWatermark(
      this.database.db,
      passKey(RESET_LOCKS_PASS),
      everyMinutes(RESET_LOCKS_MINUTES)(now),
      now,
    );
    if (!claimed) return;
    const freed = await releaseStaleLocks(this.database.db);
    // One line per freed queue, at warn: reaching here means a worker died
    // holding it, and the jobs behind it have been unclaimable ever since
    // without anything else in the system saying so.
    for (const queue of freed) {
      this.log.warn(`released a stale lock on ${queue} — a worker died holding it`);
    }
  }

  // False when the drain was skipped: a tick that lands after shutdown began
  // must not open workers against a pool that is about to close.
  private async drainOnce(): Promise<boolean> {
    if (this.stopping) return false;
    try {
      await this.releaseLocks(new Date());
    } catch (error) {
      this.log.error(`releasing stale locks failed: ${String(error)}`);
      captureError(error, { task: "releaseStaleLocks" });
    }
    try {
      await runOnce({
        // The api's OWN pool. runOnce takes pgPool (interfaces.d.ts:522);
        // handed a connectionString it would build and tear down a fresh pool
        // per tick (#229, risk 5).
        pgPool: this.database.pool,
        // The drain now shares PG_POOL_MAX (default 5) with every HTTP request
        // on this pool, so it is capped at one less than the pool: a drain at
        // full fan-out must never be able to starve every request of a
        // connection at once. WORKER_CONCURRENCY stays the operator's ceiling
        // below that, and the max(1, …) keeps a PG_POOL_MAX=1 install serial
        // rather than broken.
        concurrency: Math.max(
          1,
          Math.min(workerEnv().WORKER_CONCURRENCY, workerEnv().PG_POOL_MAX - 1),
        ),
        taskList: this.taskList,
        events: this.events,
        // graphile-worker's own signal handling is module-global: after the
        // first SIGTERM it marks the process as shutting down forever (a later
        // runOnce would throw "System has already gone into shutdown") and it
        // re-raises the signal when its pools settle, racing Nest's own
        // shutdown hooks. This service owns stopping, above.
        noHandleSignals: true,
      });
    } finally {
      this.activePool = null;
    }
    return true;
  }

  private reportTickFailure(error: unknown): void {
    // Both channels on purpose: captureError needs a DSN, and a self-hosted
    // install without one still deserves a line saying its pipeline errored.
    this.log.error(`tick failed: ${String(error)}`);
    captureError(error, { task: "tick" });
  }
}

// Resolves true/false with the drain's own verdict, or null when the deadline
// passes first. Never rejects after the deadline — the drain keeps its own
// rejection, and the caller decides who reports it.
function raceDeadline(drain: Promise<boolean>, deadlineMs: number): Promise<boolean | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), deadlineMs);
    // Never hold the process open just to time out a drain that finished.
    timer.unref();
    drain.then(
      (drained) => {
        clearTimeout(timer);
        resolve(drained);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
