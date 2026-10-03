import { monthlySavingsUsd } from "../analysis";
import type { Database } from "../db";
import { and, clusters, desc, eq, recommendations } from "../db";
import type { PrivilegeChange } from "../engine/ports";
import { newPrivilegesFor } from "../engine/provision";
import { NotifyService } from "../mail/notify.service";
import { claimWatermark, deferWatermark } from "./watermark";

// Weekly "here's what we WOULD have done" email for clusters still in
// read-only mode — the go-live conversion driver. Skips quiet clusters.
export async function runDigest(db: Database): Promise<number> {
  const readOnlyClusters = await db.select().from(clusters).where(eq(clusters.readOnly, true));
  let sent = 0;
  for (const cluster of readOnlyClusters) {
    const proposed = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.clusterId, cluster.id), eq(recommendations.state, "PROPOSED")))
      .orderBy(desc(recommendations.score));
    if (proposed.length === 0) continue;

    const drops = proposed.filter((rec) => rec.type.startsWith("DROP") || rec.type === "MERGE");
    const creates = proposed.filter((rec) => rec.type === "CREATE" || rec.type === "UPDATE");
    const advisories = proposed.filter((rec) => rec.type === "ADVISORY_REVIEW");
    const freedBytes = drops.reduce((sum, rec) => sum + rec.estimatedBytesSaved, 0);
    const monthly = monthlySavingsUsd(freedBytes);

    const top = proposed
      .slice(0, 5)
      .map(
        (rec) =>
          `  [${rec.score}] ${rec.type} ${rec.database}.${rec.collection} · ${rec.indexName}`,
      )
      .join("\n");

    const lines = [
      `This cluster is in read-only mode, so nothing was executed. Standing by:`,
      ``,
      `  ${drops.length} drop/merge recommendations (~${Math.round(freedBytes / 1024)} KB, ≈ $${monthly.toFixed(2)}/mo)`,
      `  ${creates.length} create/update recommendations`,
      `  ${advisories.length} advisories to review`,
      ``,
      `Top by confidence:`,
      top,
      ``,
      `Flip the cluster live on the dashboard to let the pipeline act (drops still observe first).`,
    ];
    await new NotifyService(db).notifyClusterOwners(
      cluster.id,
      "weekly digest — what we would have done",
      lines.join("\n"),
      "digest",
    );
    sent += 1;
  }
  return sent;
}

// A release asked for privileges a cluster's credentials are not known to hold
// (#599): told once per cluster per revision, by mail, alongside the weekly digest
// and on any cluster, live or read-only. The dashboard says it too, for as long
// as it stands; the mail is for the owner who is not looking.
//
// Once, through the same claim table the alert cooldown uses, keyed on the
// revision — so the next release that adds a privilege is news again, and this
// one is not news twice. A send that reached nobody hands the claim back, so the
// next week's run tries again rather than the notice being lost to a relay that
// was down on a Monday.
const NEVER_CLAIMED = new Date(1);

export async function runPrivilegeNotices(db: Database): Promise<number> {
  const rows = await db.select().from(clusters);
  let sent = 0;
  for (const row of rows) {
    const { pending, command, canUpgrade } = newPrivilegesFor(row);
    const last = pending.at(-1);
    if (last === undefined) continue;
    const key = `privileges:${row.id}:${last.revision}`;
    if (!(await claimWatermark(db, key, NEVER_CLAIMED))) continue;
    const settled = await new NotifyService(db).notifyClusterOwners(
      row.id,
      "new privileges Indexterity can use",
      privilegeNoticeText(pending, command, canUpgrade),
      "digest",
    );
    if (!settled) {
      await deferWatermark(db, key, new Date(0));
      continue;
    }
    sent += 1;
  }
  return sent;
}

// The mail, in the words the dashboard uses.
export function privilegeNoticeText(
  pending: readonly PrivilegeChange[],
  command: string | null,
  canUpgrade: boolean,
): string {
  const lines = [
    "A release since this cluster was connected can use privileges its credentials are not known to hold.",
    "Nothing has stopped working without them: each one turns on one feature, which stays off — with its reason in the activity trail — until it is granted.",
    "",
    ...pending.map((change) => `  ${change.key} (new in ${change.release}) — ${change.enables}`),
    "",
  ];
  if (command !== null) {
    lines.push("Run this on the cluster as an admin to grant them:", "", `  ${command}`, "");
    if (canUpgrade) {
      lines.push(
        "Or upgrade the role from the cluster's Settings page with an admin string, which is used once and never stored.",
        "",
      );
    }
  } else {
    lines.push(
      "Add them to the role you created for Indexterity — the connecting guide shows the grant for each engine.",
      "",
    );
  }
  lines.push(
    "Once the credentials hold them, the notice on the dashboard clears itself the next time Settings → Connection checks them; 'Mark as reviewed' there stops it without granting anything.",
  );
  return lines.join("\n");
}
