import type { BatchObservableResult } from "@opentelemetry/api";
import { count } from "drizzle-orm";
import { clusters, type Database, recommendations, sql } from "../db";
import {
  clustersConnected,
  jobStates,
  oldestQueuedJobAge,
  recommendationStates,
  scrapeErrors,
} from "./instruments";
import { meter } from "./provider";

// The gauges that describe current state rather than counting events, so they
// are read when a scrape asks instead of being maintained as things happen. Four
// grouped counts, one batch callback: the same numbers whichever api replica
// answers, which is why they are not per-process counters that would each report
// a fraction of the truth.

type JobStateRow = { task: string; state: string; count: number };

// A job's state is a function of its columns, not a column of its own. Order
// matters: a job that has failed before AND is waiting out its backoff is worth
// seeing as retrying rather than as ordinary future work.
const JOB_STATES = sql`
  select
    task_identifier as task,
    case
      when attempts >= max_attempts then 'dead_letter'
      when locked_at is not null then 'running'
      when attempts > 0 then 'retrying'
      when run_at > now() then 'scheduled'
      else 'queued'
    end as state,
    count(*)::int as count
  from graphile_worker.jobs
  group by 1, 2
`;

// The queue's latency, not its length: a hundred jobs a worker is chewing
// through is healthy, one job nobody has claimed for an hour is not.
const OLDEST_QUEUED = sql`
  select coalesce(max(extract(epoch from (now() - run_at))), 0)::float8 as seconds
  from graphile_worker.jobs
  where locked_at is null and attempts < max_attempts and run_at <= now()
`;

export async function observeControlPlane(
  result: BatchObservableResult,
  db: Database,
): Promise<void> {
  const clusterRows = await db
    .select({ engine: clusters.engine, readOnly: clusters.readOnly, count: count() })
    .from(clusters)
    .groupBy(clusters.engine, clusters.readOnly);
  for (const row of clusterRows) {
    result.observe(clustersConnected, row.count, {
      engine: row.engine,
      read_only: row.readOnly,
    });
  }

  const recommendationRows = await db
    .select({ state: recommendations.state, type: recommendations.type, count: count() })
    .from(recommendations)
    .groupBy(recommendations.state, recommendations.type);
  for (const row of recommendationRows) {
    result.observe(recommendationStates, row.count, { state: row.state, type: row.type });
  }

  const jobRows = await db.execute<JobStateRow>(JOB_STATES);
  for (const row of jobRows.rows) {
    result.observe(jobStates, Number(row.count), { task: row.task, state: row.state });
  }

  const oldest = await db.execute<{ seconds: number }>(OLDEST_QUEUED);
  result.observe(oldestQueuedJobAge, Number(oldest.rows[0]?.seconds ?? 0));
}

// Registered by the api only. The worker could run the same queries, but two
// deployments reporting one set of database facts is two chances to disagree,
// and the api is the workload that is always there.
export function registerControlPlaneGauges(
  db: () => Database,
  log: (message: string) => void,
): void {
  meter.addBatchObservableCallback(
    async (result) => {
      try {
        await observeControlPlane(result, db());
      } catch (error) {
        // A database that is down must not fail the whole collection — the rest
        // of the scrape is still worth serving, and the failure is reported as a
        // metric of its own rather than as a gap Prometheus would read as the
        // target being up with nothing to say.
        scrapeErrors.add(1);
        log(`metrics: control-plane gauges unavailable — ${String(error)}`);
      }
    },
    [clustersConnected, recommendationStates, jobStates, oldestQueuedJobAge],
  );
}
