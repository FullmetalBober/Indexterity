import { indexSnapshots, latencySamples, lt } from "../db";
import { jobDb } from "./db";

const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

// Time-series tables grow on every collect, forever. Prune rows older than the
// retention window (RETENTION_DAYS, default 90) — classify only needs a handful
// of recent snapshots, and the latency charts read the same window.
export async function pruneOldSamples(): Promise<number> {
  const db = jobDb();
  const envDays = Number(process.env.RETENTION_DAYS);
  const days = Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * DAY_MS);
  const prunedSamples = await db
    .delete(latencySamples)
    .where(lt(latencySamples.capturedAt, cutoff))
    .returning({ id: latencySamples.id });
  const prunedSnapshots = await db
    .delete(indexSnapshots)
    .where(lt(indexSnapshots.capturedAt, cutoff))
    .returning({ id: indexSnapshots.id });
  return prunedSamples.length + prunedSnapshots.length;
}
