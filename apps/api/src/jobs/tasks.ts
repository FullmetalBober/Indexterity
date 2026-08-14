import type { JobHelpers } from "graphile-worker";
import type { Database } from "../db";
import { isUnreachableError } from "../errors/unreachable";
import { emitPassFinished } from "../events/emit";
import { ALERT_COOLDOWN_MS, alertAllowed, notifyClusterOwners } from "../mail/notify";
import { recordClusterTask } from "../metrics";
import { InsecureConnectionError } from "../mongo/client";
import { UnsupportedServerError } from "../mongo/executor";
import { applyCluster } from "./apply";
import { refreshInferredWindow } from "./change-window";
import { classifyCluster } from "./classify";
import { ClusterCredentialsError, ClusterGoneError } from "./cluster-connection";
import { collectCluster } from "./collect";
import { applyCreatesForCluster } from "./create";
import { runDigest } from "./digest";
import { dispatchToAllClusters } from "./dispatch";
import { finalizeCluster } from "./finalize";
import { clusterIdFromPayload } from "./payload";
import { probeCluster } from "./probe";
import { pruneOldSamples } from "./retention";
import { suggestForCluster } from "./suggest";

// What a cluster task needs from the outside world, narrowed to three
// functions so the decision below is testable without a queue or a database.
// The logger is structurally satisfied by graphile-worker's own.
export interface ClusterTaskDeps {
  readonly logger: { warn(message: string): void; error(message: string): void };
  readonly alertOwners: (clusterId: string, subject: string, body: string) => Promise<void>;
  readonly emitPassFinished: (clusterId: string, task: string) => Promise<void>;
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
    recordClusterTask(task, clusterId, "ok");
    // Only the ok outcome: a skipped tick changed nothing, so there is nothing
    // for a dashboard to refetch. Best-effort by construction (emit.ts) — a
    // lost nudge must not turn a landed pass into a retried one.
    await deps.emitPassFinished(clusterId, task);
  } catch (error) {
    // Offboarded between scheduling and running. Nothing to do and nobody to
    // tell — the owners deleted it on purpose.
    if (error instanceof ClusterGoneError) {
      recordClusterTask(task, clusterId, "gone");
      return;
    }
    // The server is too old for the pipeline. No retry can fix a version, so
    // tell the owners once a day and stop — same shape as an unreachable
    // cluster, for the same reason.
    if (error instanceof UnsupportedServerError) {
      recordClusterTask(task, clusterId, "unsupported");
      deps.logger.warn(`${task}: cluster ${clusterId} — ${error.message}`);
      if (!alertAllowed(`${clusterId}:unsupported`, ALERT_COOLDOWN_MS)) return;
      await deps.alertOwners(clusterId, "cluster version not supported", error.message);
      return;
    }
    // The stored string would not connect over validated TLS. Same shape as an
    // unsupported version and for the same reason: no retry fixes it, only the
    // owner reconnecting with a TLS string can. Emphatically NOT folded into
    // "unreachable" — the cluster may be perfectly healthy and we are declining
    // to dial it, and saying "we could not reach you" would send the owner
    // hunting a firewall that is not the problem.
    if (error instanceof InsecureConnectionError) {
      recordClusterTask(task, clusterId, "insecure");
      deps.logger.warn(`${task}: cluster ${clusterId} — ${error.message}`);
      if (!alertAllowed(`${clusterId}:insecure`, ALERT_COOLDOWN_MS)) return;
      await deps.alertOwners(
        clusterId,
        `${task} skipped — this cluster's connection string is not using TLS`,
        `Indexterity now requires TLS on every connection it makes to a customer database, ` +
          `and this cluster's stored string would connect in plaintext. The ${task} step did ` +
          `nothing.\n\n${error.message}\n\nReconnect the cluster with a string that enables ` +
          `TLS and the pipeline resumes on the next tick. Nothing was executed and nothing ` +
          `was lost.`,
      );
      return;
    }
    // Undecryptable credentials need an operator, not a retry and not a
    // customer email — log it every tick so it stays visible, and move on.
    if (error instanceof ClusterCredentialsError) {
      recordClusterTask(task, clusterId, "credentials");
      deps.logger.error(`${task}: ${error.message}`);
      return;
    }
    if (!isUnreachableError(error)) {
      // Rethrown, so graphile-worker retries and eventually dead-letters it —
      // counted here too, because this is where the kind is known.
      recordClusterTask(task, clusterId, "error");
      throw error;
    }
    recordClusterTask(task, clusterId, "unreachable");
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

// Takes the database to CLOSE OVER, not to expose: the two functions below need
// it, and runClusterTask does not. Keeping it out of ClusterTaskDeps is what keeps
// that interface three functions wide and testable with no database at all.
function depsFor(db: Database, helpers: JobHelpers): ClusterTaskDeps {
  return {
    logger: helpers.logger,
    // Best-effort: a mail failure must not turn a skipped tick into a hard one.
    alertOwners: async (clusterId, subject, body) => {
      try {
        await notifyClusterOwners(db, clusterId, subject, body);
      } catch (error) {
        helpers.logger.error(`alert for cluster ${clusterId} failed: ${String(error)}`);
      }
    },
    emitPassFinished: (clusterId, task) => emitPassFinished(db, clusterId, task),
  };
}

function onCluster(
  db: Database,
  task: string,
  payload: unknown,
  helpers: JobHelpers,
  run: (clusterId: string) => Promise<unknown>,
): Promise<void> {
  return runClusterTask(task, clusterIdFromPayload(payload), depsFor(db, helpers), run);
}

// graphile-worker task registry. Per-cluster tasks (collect/classify/suggest/
// apply/finalize) plus cron dispatchers that fan those out to every cluster.
//
// A function of the database rather than a constant, because the database is the
// one thing every task here needs and the process that starts the runner is the
// thing that owns it (jobs/runner.ts). Before this, each task reached for a
// module-level singleton instead — which worked, and meant the pool's lifetime
// belonged to whichever module was imported first rather than to whoever composed
// the worker.
export function createTaskList(db: Database) {
  return {
    collect: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
      await onCluster(db, "collect", payload, helpers, async (clusterId) => {
        await collectCluster(db, clusterId);
        // Only chase a collect that actually landed — re-analysing an unchanged
        // history just re-derives yesterday's answer.
        await helpers.addJob("classify", { clusterId });
        await helpers.addJob("suggest", { clusterId });
      });
    },
    classify: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
      await onCluster(db, "classify", payload, helpers, async (clusterId) => {
        await classifyCluster(db, clusterId);
        // Same trigger, same evidence: re-derive the change window from the
        // traffic the collect just recorded.
        await refreshInferredWindow(db, clusterId);
      });
    },
    suggest: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
      // suggest builds its own auto-approved creates inline rather than waiting
      // for the next apply tick; create.ts decides which may run outside the
      // change window.
      await onCluster(db, "suggest", payload, helpers, (clusterId) =>
        suggestForCluster(db, clusterId),
      );
    },
    apply: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
      await onCluster(db, "apply", payload, helpers, async (clusterId) => {
        await applyCluster(db, clusterId);
        await applyCreatesForCluster(db, clusterId);
      });
    },
    finalize: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
      await onCluster(db, "finalize", payload, helpers, (clusterId) =>
        finalizeCluster(db, clusterId),
      );
    },
    // Every 5 minutes: is anything suddenly much slower to read than usual? If so,
    // look for the missing index now rather than at the next hourly pass.
    probe: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
      await onCluster(db, "probe", payload, helpers, async (clusterId) => {
        const findings = await probeCluster(db, clusterId);
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
    },
    scheduleProbe: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
      await dispatchToAllClusters(db, "probe", helpers);
    },
    scheduleCollect: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
      await dispatchToAllClusters(db, "collect", helpers);
    },
    scheduleSuggest: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
      await dispatchToAllClusters(db, "suggest", helpers);
    },
    scheduleApply: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
      await dispatchToAllClusters(db, "apply", helpers);
    },
    scheduleFinalize: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
      await dispatchToAllClusters(db, "finalize", helpers);
    },
    retention: async (): Promise<void> => {
      await pruneOldSamples(db);
    },
    digest: async (): Promise<void> => {
      await runDigest(db);
    },
  };
}
