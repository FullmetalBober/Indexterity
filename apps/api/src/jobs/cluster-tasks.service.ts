import { Inject, Injectable } from "@nestjs/common";
import type { JobHelpers } from "graphile-worker";
import { workerEnv } from "../config/env";
import { DatabaseService } from "../db/database.service";
import { emitPassFinished, pgNotifier } from "../events/emit";
import { ALERT_COOLDOWN_MS, alertAllowed } from "../mail/notify";
import { NotifyService } from "../mail/notify.service";
import { TunnelRegistry } from "../tunnel/tunnel.registry";
import { applyCluster } from "./apply";
import { markBlocked, markUnblocked } from "./blocked";
import { settleBuildsForCluster } from "./building";
import { refreshInferredWindow } from "./change-window";
import { classifyCluster } from "./classify";
import { collectCluster } from "./collect";
import { applyCreatesForCluster } from "./create";
import { finalizeCluster } from "./finalize";
import { clusterIdFromPayload } from "./payload";
import { probeCluster } from "./probe";
import { suggestForCluster } from "./suggest";
import { BUDGETED_PASSES, type ClusterTaskDeps, runClusterTask, withPassBudget } from "./tasks";
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
/** The one thing the passes ask of the mailer. */
export interface OwnerAlerts {
  notifyClusterOwners: NotifyService["notifyClusterOwners"];
}

@Injectable()
export class ClusterTasksService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(NotifyService) private readonly notify: OwnerAlerts,
    // Injected and handed down rather than reached for through a module
    // global: this is the one place in the pipeline the container reaches, so
    // it is the one place the dependency can be declared honestly (#353).
    private readonly tunnels: TunnelRegistry,
  ) {}

  async collect(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("collect", payload, helpers, async (clusterId) => {
      await collectCluster(this.database.db, clusterId, this.tunnels);
      // Only chase a collect that actually landed — re-analysing an unchanged
      // history just re-derives yesterday's answer.
      await helpers.addJob("classify", { clusterId });
      await helpers.addJob("suggest", { clusterId });
    });
  }

  async classify(payload: unknown, helpers: JobHelpers): Promise<void> {
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
  // BUDGETED_PASSES, rather than the pass-level budget covering both.
  async suggest(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("suggest", payload, helpers, async (clusterId) => {
      const { instantApproved } = await withPassBudget(
        "suggest",
        workerEnv().CLUSTER_PASS_BUDGET_MS,
        suggestForCluster(this.database.db, clusterId, this.tunnels),
      );
      // Immediately, as before — the scheduler is not waited for. Deliberately
      // WITHOUT the tunnel registry, which is how this call has always been made
      // from here: create.ts refuses a tunnelled cluster it has no registry for,
      // so a tunnelled cluster has never had an instant build. That looks like a
      // bug and is not this one's to change — enabling instant builds on
      // tunnelled clusters is a behaviour change, and it is filed separately.
      if (instantApproved > 0) {
        await applyCreatesForCluster(this.database.db, clusterId);
      }
    });
  }

  async apply(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("apply", payload, helpers, async (clusterId) => {
      // Ahead of both, so a build asked for on an earlier tick is finished
      // before this pass decides anything new (#332).
      await settleBuildsForCluster(this.database.db, clusterId, this.tunnels);
      await applyCluster(this.database.db, clusterId, this.tunnels);
      await applyCreatesForCluster(this.database.db, clusterId, this.tunnels);
    });
  }

  async finalize(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("finalize", payload, helpers, (clusterId) =>
      finalizeCluster(this.database.db, clusterId, this.tunnels),
    );
  }

  // Every 5 minutes: is anything suddenly much slower to read than usual? If so,
  // look for the missing index now rather than at the next hourly pass.
  async probe(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("probe", payload, helpers, async (clusterId) => {
      const findings = await probeCluster(this.database.db, clusterId, this.tunnels);
      if (findings.length === 0) return;
      for (const finding of findings) {
        helpers.logger.info(
          finding.database === null
            ? `probe: cluster under index-related pressure — ${finding.reason}`
            : `probe: ${finding.database}.${finding.collection} under read pressure — ${finding.reason}`,
        );
      }
      await helpers.addJob("suggest", { clusterId });
    });
  }

  private onCluster(
    task: string,
    payload: unknown,
    helpers: JobHelpers,
    run: (clusterId: string) => Promise<unknown>,
  ): Promise<void> {
    // The budget applies to the read-only passes only — see BUDGETED_PASSES for
    // why `apply` and `finalize` are not among them. Resolved per call rather
    // than cached, so an operator raising it does not need a restart to mean it.
    const budgetMs = BUDGETED_PASSES.has(task) ? workerEnv().CLUSTER_PASS_BUDGET_MS : null;
    return runClusterTask(
      task,
      clusterIdFromPayload(payload),
      this.depsFor(helpers),
      run,
      budgetMs,
    );
  }

  // The database is CLOSED OVER here, not exposed: these three functions need it
  // and `runClusterTask` does not. Keeping it out of ClusterTaskDeps is what keeps
  // that interface three functions wide and testable with no database at all.
  private depsFor(helpers: JobHelpers): ClusterTaskDeps {
    const db = this.database.db;
    return {
      logger: helpers.logger,
      // Best-effort: a mail failure must not turn a skipped tick into a hard one.
      alertOwners: async (clusterId, subject, body) => {
        try {
          await this.notify.notifyClusterOwners(clusterId, subject, body);
        } catch (error) {
          helpers.logger.error(`alert for cluster ${clusterId} failed: ${String(error)}`);
        }
      },
      alertAllowed: (scope) => alertAllowed(alertClaims(db), scope, ALERT_COOLDOWN_MS),
      emitPassFinished: (clusterId, task) => emitPassFinished(pgNotifier(db), clusterId, task),
      // Not best-effort: this is the only copy of why the pipeline stopped, and a
      // write that fails silently would put the dashboard back to inferring it
      // from staleness. A failure here fails the pass, which is retried.
      markBlocked: (clusterId, task, reason, detail) =>
        markBlocked(db, clusterId, task, reason, detail),
      markUnblocked: (clusterId) => markUnblocked(db, clusterId),
    };
  }
}
