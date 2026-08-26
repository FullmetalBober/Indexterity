import type { JobHelpers } from "graphile-worker";
import type { Database } from "../db";
import { InsecureConnectionError } from "../engine/tls";
import { UnsupportedServerError } from "../engine/version";
import { isUnreachableError } from "../errors/unreachable";
import { recordClusterTask } from "../metrics";
import { TunnelUnavailableError } from "../tunnel/resolve";
import { ClusterCredentialsError, ClusterGoneError } from "./cluster-connection";
import type { ClusterTasksService } from "./cluster-tasks.service";
import { runDigest } from "./digest";
import { dispatchToAllClusters } from "./dispatch";
import { pruneOldSamples } from "./retention";

// What a cluster task needs from the outside world, narrowed to three
// functions so the decision below is testable without a queue or a database.
// The logger is structurally satisfied by graphile-worker's own.
export interface ClusterTaskDeps {
  readonly logger: { warn(message: string): void; error(message: string): void };
  readonly alertOwners: (clusterId: string, subject: string, body: string) => Promise<void>;
  // Whether this alert is outside its cooldown window. A function rather than
  // the store itself for the same reason the other three are: this interface's
  // value is that a task can be tested without a queue or a database.
  readonly alertAllowed: (scope: string) => Promise<boolean>;
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
      if (!(await deps.alertAllowed(`${clusterId}:unsupported`))) return;
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
      if (!(await deps.alertAllowed(`${clusterId}:insecure`))) return;
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
    // The cluster sits behind a VPN tunnel that will not come up (#353).
    //
    // Its own outcome, emphatically NOT folded into "unreachable", for exactly
    // the reason InsecureConnectionError is not: the database may be perfectly
    // healthy and we never dialled it, so "we could not reach your cluster"
    // would send the owner hunting a firewall in front of a database that is
    // answering fine. What is down is their VPN gateway, and that is what the
    // mail says.
    //
    // Skipped rather than retried, like an unreachable cluster and for the same
    // reason (architecture §7.4.1): nothing was executed, the schedule retries
    // on the next tick, and a handshake that recovers needs nothing from us.
    // Throwing here would burn five graphile-worker retries per tick printing
    // the same stack while a customer's VPN is down for an afternoon.
    if (error instanceof TunnelUnavailableError) {
      recordClusterTask(task, clusterId, "tunnel-down");
      deps.logger.warn(
        `${task}: cluster ${clusterId} — tunnel ${error.tunnelId} is not up, skipped`,
      );
      // Keyed on the TUNNEL, not the cluster: one gateway commonly reaches
      // several clusters, and a customer whose VPN is down should get one mail
      // rather than one per database behind it.
      if (!(await deps.alertAllowed(`tunnel:${error.tunnelId}`))) return;
      await deps.alertOwners(
        clusterId,
        `${task} skipped — the VPN tunnel to this cluster is down`,
        `Indexterity reaches this cluster over a WireGuard tunnel, and that tunnel is not ` +
          `currently up — so the ${task} step did nothing and will retry on the next ` +
          `schedule tick.\n\nThe database itself may be perfectly healthy; what is not ` +
          `answering is the VPN gateway. Usual causes: the gateway is down or moved, its ` +
          `endpoint address changed, or its keys were rotated without the config here being ` +
          `updated.\n\nNothing was executed and nothing was lost — collection resumes once ` +
          `the handshake does. The tunnel's status is on the VPN tunnels page.`,
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
    if (!(await deps.alertAllowed(`${clusterId}:${task}`))) return;
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

// graphile-worker task registry: the names the queue knows, and nothing else.
//
// Per-cluster passes are methods on ClusterTasksService now (#354) and this maps
// the queue's names onto them — so what a pass can inject is a question for the
// container, and what the queue can dispatch stays one readable list. The cron
// dispatchers and the two maintenance tasks are still functions of the database;
// they move next.
//
// A function rather than a constant, because the database is the one thing every
// task here needs and the process that starts the runner is the thing that owns
// it (jobs/runner.ts). Before this, each task reached for a module-level singleton
// instead — which worked, and meant the pool's lifetime belonged to whichever
// module was imported first rather than to whoever composed the worker.
export function createTaskList(db: Database, cluster: ClusterTasksService) {
  return {
    collect: (payload: unknown, helpers: JobHelpers): Promise<void> =>
      cluster.collect(payload, helpers),
    classify: (payload: unknown, helpers: JobHelpers): Promise<void> =>
      cluster.classify(payload, helpers),
    suggest: (payload: unknown, helpers: JobHelpers): Promise<void> =>
      cluster.suggest(payload, helpers),
    apply: (payload: unknown, helpers: JobHelpers): Promise<void> =>
      cluster.apply(payload, helpers),
    finalize: (payload: unknown, helpers: JobHelpers): Promise<void> =>
      cluster.finalize(payload, helpers),
    probe: (payload: unknown, helpers: JobHelpers): Promise<void> =>
      cluster.probe(payload, helpers),
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
