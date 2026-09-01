import { Injectable } from "@nestjs/common";
import { clusters, type Database, eq, members, user } from "../db";
import { mailEnabled, sendMail } from "./mailer";
import { alertSettled } from "./notify";

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
  // (drops executed, regressions rolled back). Best-effort: it never throws.
  //
  // Returns whether the alert is SETTLED — whether there is anything a later
  // attempt could improve — which is what the cooldown claim needs to know
  // (mail/notify.ts, raiseAlert). Not "was a mail sent": the two differ on the
  // cases where no mail was ever going to be sent, and treating those as a
  // failure would re-run the same no-op every five minutes forever.
  //
  // Which of the four cases mean what is `alertSettled`'s own comment; this
  // method's job is to count the sends it made and ask.
  async notifyClusterOwners(clusterId: string, subject: string, text: string): Promise<boolean> {
    const rows = await this.db
      .select({ email: user.email, role: members.role, clusterName: clusters.name })
      .from(clusters)
      .innerJoin(members, eq(members.orgId, clusters.orgId))
      .innerJoin(user, eq(user.id, members.userId))
      .where(eq(clusters.id, clusterId));
    const clusterName = rows[0]?.clusterName ?? clusterId;
    const owners = rows.filter((row) => row.role === "owner");
    let delivered = 0;
    for (const row of owners) {
      if (await sendMail(row.email, `[Indexterity] ${clusterName}: ${subject}`, text)) delivered++;
    }
    return alertSettled(owners.length, delivered, mailEnabled());
  }
}
