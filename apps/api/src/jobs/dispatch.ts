import type { TaskSpec } from "graphile-worker";
import type { Database } from "../db";
import { clusters } from "../db";
import { observeClusterFleet } from "../metrics";

/**
 * Every connected cluster's id, as a dependency rather than a query.
 *
 * A seam, and a narrow one: this function wanted a list of ids and took a whole
 * `Database` to get one. Drizzle's `select()` returns a `PgSelectBuilder` whose
 * `.from()` gives a `PgSelectBase` — classes with phantom generics, not
 * promises — so the only way to fake that argument was to assert past the
 * compiler entirely. An interface with one method is both honestly fakeable and
 * a truer statement of what the dispatcher needs.
 */
export interface ClusterRoster {
  ids(): Promise<string[]>;
}

/** The real one, reading the control plane. */
export function clusterRoster(db: Database): ClusterRoster {
  return {
    ids: async () => (await db.select({ id: clusters.id }).from(clusters)).map((row) => row.id),
  };
}

// Fan a per-cluster data-plane task out to every connected cluster.
/**
 * The two things a dispatcher does with graphile-worker's helpers.
 *
 * `JobHelpers` is the vendor's whole surface and this uses `addJob` and one
 * logger method. Naming them is what lets a test hand over a complete object
 * instead of claiming a two-member literal is a JobHelpers — and the real
 * helpers satisfy it structurally, so no call site changes.
 */
export interface JobQueue {
  // `Promise<unknown>`, not the vendor's `Promise<Job>`: nothing in this repo
  // reads what addJob returns, and saying so is what lets a test answer with
  // anything rather than fake a Job it never looks at.
  addJob(identifier: string, payload?: unknown, options?: TaskSpec): Promise<unknown>;
  // The three the pipeline calls, and only those. graphile-worker's Logger also
  // carries `debug` and `scope`, which nothing here uses.
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export async function dispatchToAllClusters(
  roster: ClusterRoster,
  task: string,
  helpers: JobQueue,
): Promise<number> {
  const ids = await roster.ids();
  // The fleet as it stands, so the unreachable gauge forgets a cluster that was
  // offboarded while we could not reach it.
  observeClusterFleet(ids);
  for (const id of ids) {
    // Cap retries (5, exponential backoff) and dedup per cluster+task: a slow
    // or failing cluster replaces its pending job instead of piling new ones.
    //
    // The queue name is what stops one cluster's task overlapping ITSELF, and the
    // job key is not enough on its own. graphile-worker's add_job clears the key of
    // an already-LOCKED job and inserts a new one — its own migration says so:
    // "in the case of locked existing job create a new job instead as it must have
    // already started executing". So dedup covers a job still waiting and does
    // nothing about one still running.
    //
    // That was survivable at a six-hourly cadence and stops being so as the cadence
    // approaches the work. Two collects racing on one cluster would double-count
    // `observations` on every run they both extended — the number the trust gate
    // reads as "how many times we looked" — and could write two runs whose spans
    // overlap, which the exclusion constraint would then reject mid-collect. A
    // queue per cluster and task makes graphile-worker run them one at a time, which
    // is cheaper than either of those outcomes and needs no locking of our own.
    //
    // Per task as well as per cluster on purpose: the five-minute probe must not
    // queue behind a collect that walks ten thousand collections.
    await helpers.addJob(
      task,
      { clusterId: id },
      {
        maxAttempts: 5,
        jobKey: `${task}:${id}`,
        jobKeyMode: "replace",
        queueName: `${task}:${id}`,
      },
    );
  }
  helpers.logger.info(`scheduler: dispatched ${task} to ${ids.length} cluster(s)`);
  return ids.length;
}
