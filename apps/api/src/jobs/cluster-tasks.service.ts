import { Injectable } from "@nestjs/common";
import type { JobHelpers } from "graphile-worker";
import { DatabaseService } from "../db/database.service";
import { emitPassFinished } from "../events/emit";
import { ALERT_COOLDOWN_MS, alertAllowed } from "../mail/notify";
import { NotifyService } from "../mail/notify.service";
import { applyCluster } from "./apply";
import { settleBuildsForCluster } from "./building";
import { refreshInferredWindow } from "./change-window";
import { classifyCluster } from "./classify";
import { collectCluster } from "./collect";
import { applyCreatesForCluster } from "./create";
import { finalizeCluster } from "./finalize";
import { clusterIdFromPayload } from "./payload";
import { probeCluster } from "./probe";
import { suggestForCluster } from "./suggest";
import { type ClusterTaskDeps, runClusterTask } from "./tasks";
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
@Injectable()
export class ClusterTasksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notify: NotifyService,
  ) {}

  async collect(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("collect", payload, helpers, async (clusterId) => {
      await collectCluster(this.database.db, clusterId);
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
  async suggest(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("suggest", payload, helpers, (clusterId) =>
      suggestForCluster(this.database.db, clusterId),
    );
  }

  async apply(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("apply", payload, helpers, async (clusterId) => {
      // Ahead of both, so a build asked for on an earlier tick is finished
      // before this pass decides anything new (#332).
      await settleBuildsForCluster(this.database.db, clusterId);
      await applyCluster(this.database.db, clusterId);
      await applyCreatesForCluster(this.database.db, clusterId);
    });
  }

  async finalize(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("finalize", payload, helpers, (clusterId) =>
      finalizeCluster(this.database.db, clusterId),
    );
  }

  // Every 5 minutes: is anything suddenly much slower to read than usual? If so,
  // look for the missing index now rather than at the next hourly pass.
  async probe(payload: unknown, helpers: JobHelpers): Promise<void> {
    await this.onCluster("probe", payload, helpers, async (clusterId) => {
      const findings = await probeCluster(this.database.db, clusterId);
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
    return runClusterTask(task, clusterIdFromPayload(payload), this.depsFor(helpers), run);
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
      emitPassFinished: (clusterId, task) => emitPassFinished(db, clusterId, task),
    };
  }
}
