import { Injectable } from "@nestjs/common";
import { clusters, type Database, eq, members, user } from "../db";
import { sendMail } from "./mailer";

// Who to tell, which needs the pool (#354).
//
// The transport itself stays a process-wide singleton in ./mailer and is NOT a
// provider — one SMTP connection per process is the correct number, and a
// per-instance field would make two the moment `auth/auth.config.ts` built its
// own, which it does at import time by decision. Same answer as errors/reporting
// and its Sentry client, for the same reason.
//
// `alertAllowed` stays a function too: it takes its claim store as an argument, so
// there is nothing to inject and it is testable without a database — which is
// what its own comment says it exists for.
@Injectable()
export class NotifyService {
  // The Database and not DatabaseService, with mail.module.ts registering a
  // factory that unwraps one — so a plain worker function, which is what most of
  // jobs/ still is, can build one with no cast.
  constructor(private readonly db: Database) {}

  // Email every owner of the cluster's org — the audience for engine alerts
  // (drops executed, regressions rolled back). Best-effort.
  async notifyClusterOwners(clusterId: string, subject: string, text: string): Promise<void> {
    const rows = await this.db
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
}
