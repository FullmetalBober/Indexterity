import { clusters, type Database, eq, members, user } from "../db";
import { sendMail } from "./mailer";

// Repeating alerts (a cluster that has been unreachable for a week fails its
// collect every hour) become noise nobody reads. One per key per window.
//
// The window has to survive a process EXIT, which is what #212 changed. This
// was a module-level Map, on the argument that the worker is a single replica
// and a restart re-alerting once is the right failure mode. Burst mode is a
// whole process per tick: on a fifteen-minute cron that Map is empty 96 times a
// day, and a cluster unreachable since Tuesday would mail its owners 96 times.
// A restart re-alerting once is a fine failure mode; a restart every tick is
// not, so the claim moved to the same table the burst schedule uses — both are
// "claim this key if nothing has claimed it since T" (jobs/watermark.ts).
//
// Injected rather than reached for, so the rule below is testable without a
// database and so the caller decides what the claim is backed by.
export type ClaimStore = (key: string, notBefore: Date, now: Date) => Promise<boolean>;

// One alert per cluster+task per day, shared by both paths that raise them:
// a task that burned its last retry, and one that skipped because the cluster
// was unreachable.
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function alertAllowed(
  claim: ClaimStore,
  key: string,
  cooldownMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  return claim(key, new Date(now.getTime() - cooldownMs), now);
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
