import type { JobHelpers } from "graphile-worker";
import { isUnreachableError } from "../errors/unreachable";
import { ALERT_COOLDOWN_MS, alertAllowed, notifyClusterOwners } from "../mail/notify";
import { UnsupportedServerError } from "../mongo/executor";
import { applyCluster } from "./apply";
import { refreshInferredWindow } from "./change-window";
import { classifyCluster } from "./classify";
import { ClusterCredentialsError } from "./cluster-connection";
import { collectCluster } from "./collect";
import { applyCreatesForCluster } from "./create";
import { jobDb } from "./db";
import { runDigest } from "./digest";
import { dispatchToAllClusters } from "./dispatch";
import { finalizeCluster } from "./finalize";
import { clusterIdFromPayload } from "./payload";
import { probeCluster } from "./probe";
import { pruneOldSamples } from "./retention";
import { suggestForCluster } from "./suggest";

// What a cluster task needs from the outside world, narrowed to two functions
// so the decision below is testable without a queue or a database. Structurally
// satisfied by graphile-worker's own logger.
export interface ClusterTaskDeps {
  readonly logger: { warn(message: string): void; error(message: string): void };
  readonly alertOwners: (clusterId: string, subject: string, body: string) => Promise<void>;
}

// A customer cluster can be unreachable for days — maintenance, a rotated
// password, a firewall change. That is a condition the pipeline is designed
// for (architecture §7.4.1), not a bug: nothing was executed, the schedule
// retries on the next tick, and the analysis side already refuses to trust a
// usage history with a hole in it. So skip the tick rather than throwing,
// which would make graphile-worker burn five retries printing the same stack
// trace every hour and drown the failures that do need a human. Owners still
// hear about it, at most once a day.
export async function runClusterTask(
  task: string,
  clusterId: string,
  deps: ClusterTaskDeps,
  run: (clusterId: string) => Promise<unknown>,
): Promise<void> {
  try {
    await run(clusterId);
  } catch (error) {
    // The server is too old for the pipeline. No retry can fix a version, so
    // tell the owners once a day and stop — same shape as an unreachable
    // cluster, for the same reason.
    if (error instanceof UnsupportedServerError) {
      deps.logger.warn(`${task}: cluster ${clusterId} — ${error.message}`);
      if (!alertAllowed(`${clusterId}:unsupported`, ALERT_COOLDOWN_MS)) return;
      await deps.alertOwners(clusterId, "cluster version not supported", error.message);
      return;
    }
    // Undecryptable credentials need an operator, not a retry and not a
    // customer email — log it every tick so it stays visible, and move on.
    if (error instanceof ClusterCredentialsError) {
      deps.logger.error(`${task}: ${error.message}`);
      return;
    }
    if (!isUnreachableError(error)) throw error;
    deps.logger.warn(
      `${task}: cluster ${clusterId} unreachable — skipped, retrying on the next tick`,
    );
    if (!alertAllowed(`${clusterId}:${task}`, ALERT_COOLDOWN_MS)) return;
    await deps.alertOwners(
      clusterId,
      `${task} skipped — cluster unreachable`,
      `Indexterity could not reach this cluster, so the ${task} step did nothing and will ` +
        `retry on the next schedule tick.\n\nUsual causes: the cluster is paused or down, its ` +
        `network rules changed, or the connection string is stale.\n\nNothing was executed and ` +
        `nothing was lost — recommendations resume once the cluster answers again.`,
    );
  }
}

function depsFor(helpers: JobHelpers): ClusterTaskDeps {
  return {
    logger: helpers.logger,
    // Best-effort: a mail failure must not turn a skipped tick into a hard one.
    alertOwners: async (clusterId, subject, body) => {
      try {
        await notifyClusterOwners(jobDb(), clusterId, subject, body);
      } catch (error) {
        helpers.logger.error(`alert for cluster ${clusterId} failed: ${String(error)}`);
      }
    },
  };
}

function onCluster(
  task: string,
  payload: unknown,
  helpers: JobHelpers,
  run: (clusterId: string) => Promise<unknown>,
): Promise<void> {
  return runClusterTask(task, clusterIdFromPayload(payload), depsFor(helpers), run);
}

// graphile-worker task registry. Per-cluster tasks (collect/classify/suggest/
// apply/finalize) plus cron dispatchers that fan those out to every cluster.
export const taskList = {
  collect: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    await onCluster("collect", payload, helpers, async (clusterId) => {
      await collectCluster(clusterId);
      // Only chase a collect that actually landed — re-analysing an unchanged
      // history just re-derives yesterday's answer.
      await helpers.addJob("classify", { clusterId });
      await helpers.addJob("suggest", { clusterId });
    });
  },
  classify: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    await onCluster("classify", payload, helpers, async (clusterId) => {
      await classifyCluster(clusterId);
      // Same trigger, same evidence: re-derive the change window from the
      // traffic the collect just recorded.
      await refreshInferredWindow(jobDb(), clusterId);
    });
  },
  suggest: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    // suggest builds its own auto-approved creates inline rather than waiting
    // for the next apply tick; create.ts decides which may run outside the
    // change window.
    await onCluster("suggest", payload, helpers, suggestForCluster);
  },
  apply: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    await onCluster("apply", payload, helpers, async (clusterId) => {
      await applyCluster(clusterId);
      await applyCreatesForCluster(clusterId);
    });
  },
  finalize: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    await onCluster("finalize", payload, helpers, finalizeCluster);
  },
  // Every 5 minutes: is anything suddenly much slower to read than usual? If so,
  // look for the missing index now rather than at the next hourly pass.
  probe: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    await onCluster("probe", payload, helpers, async (clusterId) => {
      const findings = await probeCluster(clusterId);
      if (findings.length === 0) return;
      for (const finding of findings) {
        helpers.logger.info(
          `probe: ${finding.database}.${finding.collection} under read pressure — ${finding.reason}`,
        );
      }
      await helpers.addJob("suggest", { clusterId });
    });
  },
  scheduleProbe: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("probe", helpers);
  },
  scheduleCollect: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("collect", helpers);
  },
  scheduleSuggest: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("suggest", helpers);
  },
  scheduleApply: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("apply", helpers);
  },
  scheduleFinalize: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("finalize", helpers);
  },
  retention: async (): Promise<void> => {
    await pruneOldSamples();
  },
  digest: async (): Promise<void> => {
    await runDigest();
  },
};
