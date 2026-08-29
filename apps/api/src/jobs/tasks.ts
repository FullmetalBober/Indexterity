import type { BlockedReason } from "@repo/contracts";
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
  /**
   * Why the pipeline is not running, for a screen to read a week later. The
   * metric beside every call to this answers an operator watching a gauge; this
   * answers the owner who opens the cluster and finds week-old numbers.
   */
  readonly markBlocked: (
    clusterId: string,
    task: string,
    reason: BlockedReason,
    detail: string,
  ) => Promise<void>;
  readonly markUnblocked: (clusterId: string) => Promise<void>;
}

// A customer cluster can be unreachable for days — maintenance, a rotated
// password, a firewall change. That is a condition the pipeline is designed
// for (architecture §7.4.1), not a bug: nothing was executed, the schedule
// retries on the next tick, and the analysis side already refuses to trust a
// usage history with a hole in it. So skip the tick rather than throwing,
// which would make graphile-worker burn five retries printing the same stack
// trace every hour and drown the failures that do need a human. Owners still
// hear about it, at most once a day.
// The budget as an owner would say it, because this sentence is one they read:
// it lands in `blocked_detail` and in the alert mail. "300s" is a setting;
// "5 minutes" is a length of time.
function humanBudget(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * A read-only pass abandoned for running past its wall-clock budget (#407).
 *
 * Its own type rather than a plain Error so `runClusterTask` can tell it from a
 * failure: nothing went wrong that a message could describe, and the answer is
 * different — this one is skipped and retried on the next tick, like an
 * unreachable cluster, rather than rethrown to be retried immediately and
 * dead-lettered. Retrying a pass that just ran out of time, immediately, with
 * the same budget, is the same pass running out of time again.
 */
export class PassBudgetExceededError extends Error {
  constructor(
    readonly task: string,
    readonly budgetMs: number,
  ) {
    super(`the ${task} pass ran past its ${humanBudget(budgetMs)} budget and was abandoned`);
    this.name = "PassBudgetExceededError";
  }
}

/**
 * The passes a budget may cut off.
 *
 * Read and analyse only: they dial the customer's database, read from it, and
 * write to OUR tables. Abandoning one loses the work and nothing else, which is
 * why they can be given a deadline at all.
 *
 * `apply` and `finalize` are deliberately absent. They change indexes on the
 * customer's database and record audit rows with rollback tokens, and a pass cut
 * off between the change and its record is a change we have half a record of.
 * They also legitimately take a long time — a large index build is measured in
 * tens of minutes — so a budget would be wrong twice over. What bounds them is
 * the per-statement timeout in each adapter, which is its own question (#410).
 */
export const BUDGETED_PASSES: ReadonlySet<string> = new Set([
  "collect",
  "classify",
  "suggest",
  "probe",
]);

/**
 * Run a pass against a wall clock, rejecting if it outlasts it.
 *
 * **This abandons the pass; it does not stop it.** The work carries on until
 * whatever it is waiting on gives up on its own — the per-statement timeout, or
 * the socket. What it frees immediately is the WORKER SLOT, and that is the
 * failure being fixed: WORKER_CONCURRENCY is 1, so a pass that cannot finish
 * kept `collect`, `apply`, `probe` and the dispatchers queued behind it for as
 * long as it went on. Actually cancelling the query means threading an
 * AbortSignal through all three drivers, which is worth doing and is not this.
 *
 * The timer is cleared on both paths, so a fast pass leaves nothing pending that
 * would hold the event loop open for the rest of the budget.
 */
async function withBudget<T>(task: string, budgetMs: number, run: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PassBudgetExceededError(task, budgetMs)), budgetMs);
  });
  try {
    return await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runClusterTask(
  task: string,
  clusterId: string,
  deps: ClusterTaskDeps,
  run: (clusterId: string) => Promise<unknown>,
  budgetMs: number | null = null,
): Promise<void> {
  try {
    const pass = run(clusterId);
    await (budgetMs === null ? pass : withBudget(task, budgetMs, pass));
    recordClusterTask(task, clusterId, "ok");
    // A pass that got through clears whatever stopped the last one: the state is
    // "why the pipeline is not running", so it cannot outlive a run.
    await deps.markUnblocked(clusterId);
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
      await deps.markBlocked(clusterId, task, "UNSUPPORTED", error.message);
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
      await deps.markBlocked(clusterId, task, "INSECURE", error.message);
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
      await deps.markBlocked(
        clusterId,
        task,
        "TUNNEL_DOWN",
        "The VPN tunnel this cluster is reached through is not up. The database itself may be " +
          "answering fine; what is not is the gateway.",
      );
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
      await deps.markBlocked(clusterId, task, "CREDENTIALS", error.message);
      deps.logger.error(`${task}: ${error.message}`);
      return;
    }
    // Ran past its budget (#407). Skipped rather than rethrown, exactly like an
    // unreachable cluster and for the same reason: graphile-worker would retry
    // immediately, the retry gets the same budget against the same cluster, and
    // five attempts later it is dead-lettered having achieved nothing but five
    // budgets of the only worker slot. The next tick tries again from a clean
    // start, which is the behaviour that lets the fleet keep moving.
    if (error instanceof PassBudgetExceededError) {
      recordClusterTask(task, clusterId, "timed-out");
      await deps.markBlocked(clusterId, task, "TIMED_OUT", error.message);
      deps.logger.warn(`${task}: cluster ${clusterId} — ${error.message}`);
      if (!(await deps.alertAllowed(`${clusterId}:timed-out`))) return;
      await deps.alertOwners(
        clusterId,
        `${task} is taking longer than Indexterity will wait`,
        `The ${task} step against this cluster ran for longer than its budget and was ` +
          `abandoned, so it did nothing. Nothing was executed and nothing was lost.\n\n` +
          `This usually means the cluster is very large, very busy, or reached over a slow ` +
          `link — the step is not failing so much as not fitting. Whoever runs this ` +
          `Indexterity can raise the budget (CLUSTER_PASS_BUDGET_MS) if the cluster genuinely ` +
          `needs longer.`,
      );
      return;
    }
    if (!isUnreachableError(error)) {
      // Rethrown, so graphile-worker retries and eventually dead-letters it —
      // counted here too, because this is where the kind is known.
      recordClusterTask(task, clusterId, "error");
      // Recorded before the rethrow: graphile-worker will retry and eventually
      // dead-letter this, and the owner should not have to wait for that to find
      // out their cluster stopped.
      await deps.markBlocked(clusterId, task, "ERROR", messageOf(error));
      throw error;
    }
    recordClusterTask(task, clusterId, "unreachable");
    await deps.markBlocked(clusterId, task, "UNREACHABLE", messageOf(error));
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

// A sentence for the badge, from whatever was thrown. The driver's own words are
// usually the useful ones — "connect ETIMEDOUT 10.0.0.5:27017" tells an owner
// more than any wording of ours — and the address in them is their own.
function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}
