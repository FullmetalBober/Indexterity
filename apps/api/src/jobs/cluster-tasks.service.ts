import { Inject, Injectable } from "@nestjs/common";
import { DatabaseService } from "../db/database.service";
import { timePhase } from "../engine/phases";
import { emitPassFinished, pgNotifier } from "../events/emit";
import { raiseAlert } from "../mail/notify";
import { NotifyService } from "../mail/notify.service";
import { TunnelRegistry } from "../tunnel/tunnel.registry";
import { applyCluster } from "./apply";
import { markBlocked, markUnblocked } from "./blocked";
import { settleBuildsForCluster } from "./building";
import { refreshInferredWindow } from "./change-window";
import { classifyCluster } from "./classify";
import { classifyChaseIsDue } from "./classify-cadence";
import { collectCluster } from "./collect";
import { applyCreatesForCluster } from "./create";
import { enqueueClusterPass, type JobQueue, runningPasses } from "./dispatch";
import { finalizeCluster } from "./finalize";
import {
  isDue,
  isPaced,
  nextTier,
  PASS_BUDGET_MS,
  type Pace,
  pacedBudgetMs,
  pacedEveryHours,
  paceOf,
  UNPACED,
} from "./pacing";
import { clusterIdFromPayload } from "./payload";
import { probeCluster } from "./probe";
import { suggestForCluster } from "./suggest";
import { BUDGETED_PASSES, type ClusterTaskDeps, runClusterTask, withPassBudget } from "./tasks";
import { recordPassTiming } from "./timings";
import { alertClaims } from "./watermark";

// The per-cluster half of the graphile-worker task registry, as a provider
// (#354).
//
// The queue itself stays graphile-worker: it is a durable postgres queue with
// multi-replica locking, and neither Nest package replaces that — @nestjs/schedule
// keeps no state, so a second api replica would run every pass twice, and
// @nestjs/bullmq wants a Redis this deployment does not have. What moves into the
// container is who OWNS the handlers, so that a pass can be handed a service
// instead of importing one.
//
// The decision table stays out of here on purpose. `runClusterTask` in ./tasks is
// where "which failures does a pass survive" lives, it is pure, and its own tests
// need neither a queue nor a database — this class is the wiring that decides
// WHICH database and WHICH pass, and nothing else.
/**
 * The six per-cluster passes, as an interface.
 *
 * Narrower than the class in the way that matters: `ClusterTasksService` also
 * carries five private members, and a private field makes a class NOMINALLY
 * typed — no object literal can ever satisfy it, however complete. So a test
 * either constructs the real service and its three dependencies, or asserts
 * past the compiler. This is the third option.
 */
export interface ClusterPasses {
  collect(payload: unknown, helpers: JobQueue): Promise<void>;
  classify(payload: unknown, helpers: JobQueue): Promise<void>;
  suggest(payload: unknown, helpers: JobQueue): Promise<void>;
  apply(payload: unknown, helpers: JobQueue): Promise<void>;
  finalize(payload: unknown, helpers: JobQueue): Promise<void>;
  probe(payload: unknown, helpers: JobQueue): Promise<void>;
}

/** The one thing the passes ask of the database service. */
export interface PassDatabase {
  db: DatabaseService["db"];
}

/** The one thing the passes ask of the mailer. */
export interface OwnerAlerts {
  notifyClusterOwners: NotifyService["notifyClusterOwners"];
}

/** What a pass is handed besides its cluster. */
interface PassRun {
  /**
   * Run `work` against this pass's budget — paced, where the pass is — and
   * remember how long it took. Only `suggest` calls it: it is the one pass that
   * budgets part of itself (see `suggest`), and every other budget is applied
   * by `runClusterTask` to the whole run.
   */
  budgeted<T>(work: Promise<T>): Promise<T>;
}

@Injectable()
export class ClusterTasksService {
  constructor(
    @Inject(DatabaseService) private readonly database: PassDatabase,
    @Inject(NotifyService) private readonly notify: OwnerAlerts,
    // Injected and handed down rather than reached for through a module
    // global: this is the one place in the pipeline the container reaches, so
    // it is the one place the dependency can be declared honestly (#353).
    private readonly tunnels: TunnelRegistry,
  ) {}

  async collect(payload: unknown, helpers: JobQueue): Promise<void> {
    await this.onCluster("collect", payload, helpers, async (clusterId) => {
      const collected = await collectCluster(this.database.db, clusterId, this.tunnels);
      // Only chase a collect that actually landed — re-analysing an unchanged
      // history just re-derives yesterday's answer. Enqueued the way the
      // schedulers enqueue (#454): keyed, queued per cluster, five attempts —
      // so a chased suggest dedupes against the hourly one instead of running
      // beside it with the library's default of twenty-five retries.
      const running = runningPasses(this.database.db);
      // That sentence was the intent from the start and this is the code for it
      // (#482, #483). "The collect landed" is not the same claim as "the collect
      // learned something": every collect sees every index, so it landed either
      // way, and `classify` was chased hourly to re-derive a verdict that rests
      // on weeks of evidence from a series one reading longer.
      //
      // `collected.inserted` is the honest test — a row is inserted only when
      // the state it records is new — and jobs/classify-cadence.ts turns it into
      // an interval, with a longer one rather than none when nothing was learned.
      // Skipped ticks are LOGGED rather than silent: "no recommendations changed
      // today" reads identically to a pipeline that stopped, and that is the one
      // question this must not make harder to answer.
      if (await classifyChaseIsDue(this.database.db, clusterId, collected.inserted > 0)) {
        await enqueueClusterPass(helpers, running, "classify", clusterId);
      } else {
        helpers.logger.info(
          `collect: cluster ${clusterId} wrote ${collected.inserted} new reading(s) ` +
            `and extended ${collected.extended} — classify is not due yet`,
        );
      }
      await enqueueClusterPass(helpers, running, "suggest", clusterId);
    });
  }

  async classify(payload: unknown, helpers: JobQueue): Promise<void> {
    await this.onCluster("classify", payload, helpers, async (clusterId) => {
      await classifyCluster(this.database.db, clusterId);
      // Same trigger, same evidence: re-derive the change window from the
      // traffic the collect just recorded.
      await refreshInferredWindow(this.database.db, clusterId);
    });
  }

  // suggest builds its own auto-approved creates inline rather than waiting for
  // the next apply tick; create.ts decides which may run outside the change
  // window.
  // The one pass that budgets itself, because only half of it may be (#407).
  //
  // The analysis reads the customer's database and writes recommendations to
  // ours, so a wall clock on it is safe — that is the half that ran for hours on
  // a 13-database cluster. The build it can auto-approve (D7, instant apply) is
  // the same kind of work `apply` does, and a budget must never cut one off:
  // abandoning the pass does not stop the index being built, it only stops us
  // recording it, taking its write-latency baseline and moving it to ACTIVE.
  //
  // So the budget wraps the analysis explicitly and `suggest` stays out of
  // BUDGETED_PASSES, rather than the pass-level budget covering both. It is the
  // paced budget (#588): a cluster whose analysis does not fit an hour gets
  // longer and runs less often, and the tier is decided by how long the
  // ANALYSIS took — `pass.budgeted` measures exactly the part the budget covers,
  // so a long instant build cannot pace a cluster whose analysis fits.
  async suggest(payload: unknown, helpers: JobQueue): Promise<void> {
    await this.onCluster("suggest", payload, helpers, async (clusterId, pass) => {
      const { instantApproved } = await pass.budgeted(
        suggestForCluster(this.database.db, clusterId, this.tunnels),
      );
      // Immediately, as before — the scheduler is not waited for. Deliberately
      // WITHOUT the tunnel registry, which is how this call has always been made
      // from here: create.ts refuses a tunnelled cluster it has no registry for,
      // so a tunnelled cluster has never had an instant build. That looks like a
      // bug and is not this one's to change — enabling instant builds on
      // tunnelled clusters is a behaviour change, and it is filed separately.
      if (instantApproved > 0) {
        // A phase of its own, so a suggest that ran long because it BUILT says
        // so in the Passes panel rather than reading as a slow analysis.
        await timePhase("instantBuild", () => applyCreatesForCluster(this.database.db, clusterId));
      }
    });
  }

  async apply(payload: unknown, helpers: JobQueue): Promise<void> {
    await this.onCluster("apply", payload, helpers, async (clusterId) => {
      // Ahead of both, so a build asked for on an earlier tick is finished
      // before this pass decides anything new (#332).
      await settleBuildsForCluster(this.database.db, clusterId, this.tunnels);
      await applyCluster(this.database.db, clusterId, this.tunnels);
      await applyCreatesForCluster(this.database.db, clusterId, this.tunnels);
    });
  }

  async finalize(payload: unknown, helpers: JobQueue): Promise<void> {
    await this.onCluster("finalize", payload, helpers, (clusterId) =>
      finalizeCluster(this.database.db, clusterId, this.tunnels),
    );
  }

  // Every 5 minutes: is anything suddenly much slower to read than usual? If so,
  // look for the missing index now rather than at the next hourly pass.
  async probe(payload: unknown, helpers: JobQueue): Promise<void> {
    await this.onCluster("probe", payload, helpers, async (clusterId) => {
      const findings = await probeCluster(this.database.db, clusterId, this.tunnels, (database) =>
        helpers.logger.info(
          `probe: cluster ${clusterId} — ${database}'s query plans are not all attributed yet, ` +
            `so its read pressure waits for the next collect`,
        ),
      );
      if (findings.length === 0) return;
      for (const finding of findings) {
        helpers.logger.info(
          finding.database === null
            ? `probe: cluster under index-related pressure — ${finding.reason}`
            : `probe: ${finding.database}.${finding.collection} under read pressure — ${finding.reason}`,
        );
      }
      await enqueueClusterPass(helpers, runningPasses(this.database.db), "suggest", clusterId);
    });
  }

  private async onCluster(
    task: string,
    payload: unknown,
    helpers: JobQueue,
    run: (clusterId: string, pass: PassRun) => Promise<unknown>,
  ): Promise<void> {
    const clusterId = clusterIdFromPayload(payload);
    // The budget applies to the read-only passes only — see BUDGETED_PASSES for
    // why `apply` and `finalize` are not among them. And `collect` and `suggest`
    // are paced per cluster (#571, #588): one that does not fit runs less often
    // with proportionally longer, by the tier its last run left.
    const pace = isPaced(task) ? await this.paceOf(task, clusterId, helpers) : null;
    // A suggest that is paced and not due stands down HERE, not only at the
    // dispatcher. It has two other triggers — the end of every collect, and any
    // probe that finds read pressure — and its share of the worker slot is only
    // bounded if the pace holds for all three. Nothing is recorded: the timing
    // row's start is what the next due check counts from.
    //
    // A collect is not gated here. Its only triggers besides the dispatcher are
    // a cluster being connected and its string being rotated, and whoever did
    // either is waiting on that collect.
    if (task === "suggest" && pace !== null && !isDue(pace.tier, pace.lastStartedAt, new Date())) {
      helpers.logger.info(
        `suggest: cluster ${clusterId} is paced to every ${pacedEveryHours(pace.tier)} hours ` +
          `and is not due — this one stands down`,
      );
      return;
    }
    const passBudgetMs =
      pace !== null ? pacedBudgetMs(pace.tier) : BUDGETED_PASSES.has(task) ? PASS_BUDGET_MS : null;
    // How long the part under the budget took, when the pass applies its budget
    // itself (`suggest`) — the evidence its next tier is decided on. Null for
    // every other pass, whose budget covers the whole run.
    let budgetedMs: number | null = null;
    const pass: PassRun = {
      budgeted: async (work) => {
        const started = Date.now();
        const result = await withPassBudget(task, passBudgetMs ?? PASS_BUDGET_MS, work);
        budgetedMs = Date.now() - started;
        return result;
      },
    };
    return runClusterTask(
      task,
      clusterId,
      this.depsFor(helpers, pace?.tier ?? null, () => budgetedMs),
      (id) => run(id, pass),
      // `suggest` budgets itself (above), so the runner gives it no wall clock —
      // and reports the one it applied.
      task === "suggest" ? null : passBudgetMs,
      passBudgetMs,
    );
  }

  // The database is CLOSED OVER here, not exposed: these three functions need it
  // and `runClusterTask` does not. Keeping it out of ClusterTaskDeps is what keeps
  // that interface three functions wide and testable with no database at all.
  // The pace a paced pass runs at, or the unpaced one when it cannot be read.
  //
  // Advisory, so it must never be what stops a pass: a pace that cannot be read
  // is the hourly pass at the base budget, which is exactly what every cluster
  // had before pacing existed. The case that matters is a deploy that lands
  // before its migration — on a host with no pre-deploy hook the table may be a
  // few minutes behind the code, and every collect failing for it would be a
  // regression bought by an optimisation. Logged as an error, because it is one,
  // rather than swallowed.
  private async paceOf(task: string, clusterId: string, helpers: JobQueue): Promise<Pace> {
    try {
      return await paceOf(this.database.db, clusterId, task);
    } catch (error) {
      helpers.logger.error(
        `${task}: reading the pace for cluster ${clusterId} failed, running it unpaced: ${String(error)}`,
      );
      return UNPACED;
    }
  }

  // `tier` is the pace the pass was run at, or null for a pass that is not
  // paced; the timing records the tier the NEXT run gets, decided from this one
  // — from the time the budget covered, which `budgetedMs` reports when the pass
  // applied its budget to only part of itself.
  private depsFor(
    helpers: JobQueue,
    tier: number | null,
    budgetedMs: () => number | null,
  ): ClusterTaskDeps {
    const db = this.database.db;
    return {
      logger: helpers.logger,
      // Best-effort: a mail failure must not turn a skipped tick into a hard one.
      //
      // "Best-effort" no longer means "unnoticed", which is the #419 fix. A send
      // that reaches no owner hands most of the cooldown back through
      // `raiseAlert`, so the next occurrence of the same failure alerts again
      // instead of the fault silently spending the day's claim. A THROW from the
      // notifier — a control-plane read that failed, not a refused mail — is
      // still swallowed here and still burns the claim: it is a fault on our
      // side, it is logged, and the alternative is failing a tick that skipped
      // for an unrelated reason.
      alert: async (scope, clusterId, subject, body) => {
        try {
          await raiseAlert(alertClaims(db), scope, () =>
            this.notify.notifyClusterOwners(clusterId, subject, body, "alert"),
          );
        } catch (error) {
          helpers.logger.error(`alert for cluster ${clusterId} failed: ${String(error)}`);
        }
      },
      emitPassFinished: (clusterId, task) => emitPassFinished(pgNotifier(db), clusterId, task),
      // Not best-effort: this is the only copy of why the pipeline stopped, and a
      // write that fails silently would put the dashboard back to inferring it
      // from staleness. A failure here fails the pass, which is retried.
      markBlocked: (clusterId, task, reason, detail) =>
        markBlocked(db, clusterId, task, reason, detail),
      markUnblocked: (clusterId, task) => markUnblocked(db, clusterId, task),
      // Best-effort, the opposite call to `markBlocked`'s and for the opposite
      // reason (#571): a block is the only copy of why the pipeline stopped, and
      // a timing is a measurement of a pass that has already done its work. A
      // write that fails leaves a gap on a screen, not a pass to retry.
      recordTiming: async (clusterId, task, timing) => {
        const next =
          tier === null ? 0 : nextTier(tier, timing.outcome, budgetedMs() ?? timing.durationMs);
        if (tier !== null && next !== tier) {
          helpers.logger.info(
            `${task}: cluster ${clusterId} took ${Math.round(timing.durationMs / 1000)}s ` +
              `(${timing.outcome}) — pacing it from tier ${tier} to ${next}`,
          );
        }
        try {
          await recordPassTiming(db, clusterId, task, timing, next);
        } catch (error) {
          helpers.logger.error(
            `${task}: recording the timing for cluster ${clusterId} failed: ${String(error)}`,
          );
        }
      },
    };
  }
}
