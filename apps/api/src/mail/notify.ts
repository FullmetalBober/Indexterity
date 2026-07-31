import { clusters, type Database, eq, members, user } from "../db";
import { sendMail } from "./mailer";

// Repeating alerts (a cluster that has been unreachable for a week fails its
// collect every 6h) become noise nobody reads. One per key per window.
// In-memory is enough: the worker that raises them runs as a single replica,
// and a restart re-alerting once is the right failure mode.
const lastAlert = new Map<string, number>();

// One alert per cluster+task per day, shared by both paths that raise them:
// a task that burned its last retry, and one that skipped because the cluster
// was unreachable.
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function alertAllowed(key: string, cooldownMs: number, now = Date.now()): boolean {
  const previous = lastAlert.get(key);
  if (previous !== undefined && now - previous < cooldownMs) return false;
  lastAlert.set(key, now);
  return true;
}

export function resetAlertCooldowns(): void {
  lastAlert.clear();
}

// Email every owner of the cluster's org — the audience for engine alerts
// (drops executed, regressions rolled back). Best-effort.
export async function notifyClusterOwners(
  db: Database,
  clusterId: string,
  subject: string,
  text: string,
): Promise<void> {
  const rows = await db
    .select({ email: user.email, role: members.role, clusterName: clusters.name })
    .from(clusters)
    .innerJoin(members, eq(members.orgId, clusters.orgId))
    .innerJoin(user, eq(user.id, members.userId))
    .where(eq(clusters.id, clusterId));
  const clusterName = rows[0]?.clusterName ?? clusterId;
  for (const row of rows) {
    if (row.role !== "owner") continue;
    await sendMail(row.email, `[Indexterity] ${clusterName}: ${subject}`, text);
  }
}
