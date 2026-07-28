import { clusters, type Database, eq, members, user } from "../db";
import { sendMail } from "./mailer";

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
    await sendMail(row.email, `[mongo-optimizer] ${clusterName}: ${subject}`, text);
  }
}
