import { clusters, type Database, eq, sql } from "../db";
import type { EngineSession } from "../engine/ports";
import { currentPrivilegesRevision, heldPrivilegesRevision } from "../engine/provision";

// Whether a cluster's credentials already hold what a release added (#599), asked
// of the connection a collect has open anyway.
//
// A notice about a privilege is only worth showing once somebody has looked: Atlas's
// atlasAdmin carries enableProfiler through dbAdminAnyDatabase, and telling its
// owner to grant what it holds teaches them to ignore the next notice. So each
// collect that finds a change past what is held asks the cluster — one
// connectionStatus and one listDatabases on a connection already open — and
// records both answers: how far along the changes the credentials are, and that
// they have been checked that far. What is held goes away for good; what is not
// is then known to be missing, and is what the owner is told.
//
// Asked again on every collect while anything is missing, so a grant run by hand
// clears the notice within the hour without anybody opening the credentials card.
// Never a reason for the collect to fail: a check that cannot be answered leaves
// both columns as they were and is asked again next time.
export async function checkNewPrivileges(
  db: Database,
  clusterId: string,
  session: EngineSession,
  observedDatabases: readonly string[] | null,
): Promise<void> {
  const [row] = await db
    .select({ engine: clusters.engine, privilegesRevision: clusters.privilegesRevision })
    .from(clusters)
    .where(eq(clusters.id, clusterId))
    .limit(1);
  if (row === undefined) return;
  const current = currentPrivilegesRevision(row.engine);
  if (row.privilegesRevision >= current) return;
  const checks = await session.checkPrivileges(observedDatabases);
  if (checks === null) return;
  const held = heldPrivilegesRevision(row.engine, checks);
  await db
    .update(clusters)
    .set({
      privilegesRevision: sql`greatest(${clusters.privilegesRevision}, ${held})`,
      privilegesCheckedRevision: sql`greatest(${clusters.privilegesCheckedRevision}, ${current})`,
    })
    .where(eq(clusters.id, clusterId));
}
