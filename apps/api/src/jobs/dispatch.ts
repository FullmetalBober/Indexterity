import type { JobHelpers } from "graphile-worker";
import { clusters } from "../db";
import { observeClusterFleet } from "../metrics";
import { jobDb } from "./db";

// Fan a per-cluster data-plane task out to every connected cluster.
export async function dispatchToAllClusters(task: string, helpers: JobHelpers): Promise<number> {
  const db = jobDb();
  const rows = await db.select({ id: clusters.id }).from(clusters);
  // The fleet as it stands, so the unreachable gauge forgets a cluster that was
  // offboarded while we could not reach it.
  observeClusterFleet(rows.map((row) => row.id));
  for (const row of rows) {
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
      { clusterId: row.id },
      {
        maxAttempts: 5,
        jobKey: `${task}:${row.id}`,
        jobKeyMode: "replace",
        queueName: `${task}:${row.id}`,
      },
    );
  }
  helpers.logger.info(`scheduler: dispatched ${task} to ${rows.length} cluster(s)`);
  return rows.length;
}
