import { monthlySavingsUsd } from "../analysis";
import type { Database } from "../db";
import { and, clusters, desc, eq, recommendations } from "../db";
import { NotifyService } from "../mail/notify.service";

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
    );
    sent += 1;
  }
  return sent;
}
