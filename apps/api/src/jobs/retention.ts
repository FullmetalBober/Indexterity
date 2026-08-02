import { makeWorkerUtils } from "graphile-worker";
import { indexSnapshots, latencySamples, lt, sql } from "../db";
import { requiredEnv } from "../env";
import { jobDb } from "./db";

const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
// One batch per run. A backlog drains over consecutive days rather than holding
// a transaction open over a hundred thousand rows.
const MAX_DEAD_LETTERS_PER_RUN = 5000;

function retentionCutoff(): Date {
  const envDays = Number(process.env.RETENTION_DAYS);
  const days = Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_RETENTION_DAYS;
  return new Date(Date.now() - days * DAY_MS);
}

// A job that burns its last attempt keeps its row, as the record of what went
// wrong. Nothing ever removes it. A cluster unreachable for a week, or an
// offboarded one whose ticks were already queued, leaves rows in the
// control-plane database permanently — the same unbounded growth the
// time-series tables were pruned for, in the one table nobody was watching.
//
// Old failures are not diagnostics, they are debris: past the retention window
// nobody is going to read them. Removed on the same schedule and the same knob
// as everything else.
//
// `graphile_worker.jobs` is the public view; `_private_jobs` is private and its
// shape moves between releases. completeJobs() is the supported way to delete a
// job row, so the ids come from the view and the deletion goes through the API.
export async function pruneDeadLetterJobs(): Promise<number> {
  const rows = await jobDb().execute(sql`
    select id::text as id from graphile_worker.jobs
    where attempts >= max_attempts
      and locked_at is null
      and updated_at < ${retentionCutoff()}
    limit ${MAX_DEAD_LETTERS_PER_RUN}
  `);
  const ids = rows.rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
  if (ids.length === 0) return 0;
  const utils = await makeWorkerUtils({ connectionString: requiredEnv("DATABASE_URL") });
  try {
    await utils.completeJobs(ids);
  } finally {
    await utils.release();
  }
  return ids.length;
}

// Time-series tables grow on every collect, forever. Prune rows older than the
// retention window (RETENTION_DAYS, default 90) — classify only needs a handful
// of recent snapshots, and the latency charts read the same window.
export async function pruneOldSamples(): Promise<number> {
  const db = jobDb();
  const cutoff = retentionCutoff();
  const prunedSamples = await db
    .delete(latencySamples)
    .where(lt(latencySamples.capturedAt, cutoff))
    .returning({ id: latencySamples.id });
  const prunedSnapshots = await db
    .delete(indexSnapshots)
    .where(lt(indexSnapshots.capturedAt, cutoff))
    .returning({ id: indexSnapshots.id });
  return prunedSamples.length + prunedSnapshots.length + (await pruneDeadLetterJobs());
}
