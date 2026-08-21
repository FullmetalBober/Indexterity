import { and, clusters, type Database, eq, inArray, recommendations } from "../db";
import { openClusterSession } from "../jobs/cluster-connection";
import { evictCluster } from "../jobs/connection-pool";

// Leaving a customer's cluster as we found it.
//
// Extracted from deleteCluster because there are two ways out now: disconnecting
// one cluster from the dashboard, and deleting the organization that holds them
// all. The second used to be impossible, and when it became possible the
// interesting part was that a cascade deletes OUR rows and nothing on their
// server — an index we hid stays hidden, a user we created stays created.

// Un-hide anything still parked in the observe window and drop the pooled
// connection. Returns how many indexes were restored.
//
// Deleting the row is the caller's business: one disconnect deletes it and
// reports what happened, an org deletion lets the cascade do it. Restoration
// runs even on a read-only cluster — we hid the index, so putting it back is not
// a change the customer has to have opted into.
export async function restoreHiddenIndexes(db: Database, clusterId: string): Promise<number> {
  const inFlight = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        inArray(recommendations.state, ["HIDDEN", "OBSERVE"]),
      ),
    );
  let unhidden = 0;
  if (inFlight.length > 0) {
    try {
      const { session, canHide, release } = await openClusterSession(db, clusterId);
      try {
        const executor = session.executor(false);
        // An engine with no reversible hide left every one of these indexes
        // serving traffic, so there is nothing to put back — and calling unhide
        // would ask its executor for a write it refuses. The recommendations are
        // discarded with the cluster either way.
        for (const rec of canHide ? inFlight : []) {
          try {
            await executor.unhide(rec.database, rec.collection, rec.indexName);
            unhidden += 1;
          } catch {
            // index already gone — nothing to restore
          }
        }
      } finally {
        release();
      }
    } catch {
      // cluster unreachable: offboarding still proceeds
    }
  }
  await evictCluster(clusterId);
  return unhidden;
}

// The mongo shell command that removes the least-privilege user Indexterity
// created during admin-string onboarding. Null when the customer pasted a
// ready-made string, because then there is nothing of ours on their cluster.
//
// Handed back rather than run: dropping a user needs admin credentials we
// deliberately did not keep, and guessing that the analysis credentials will do
// it would fail at exactly the moment nobody is watching.
export function revokeCommandFor(provisionedUsername: string | null): string | null {
  return provisionedUsername === null
    ? null
    : `db.getSiblingDB("admin").dropUser("${provisionedUsername}")`;
}

// Every provisioned user an org would leave behind on someone else's cluster.
// Shown before an org is deleted, because after it there is no row left to say
// which server the user is on or what it was called.
export async function provisionedUsersIn(
  db: Database,
  orgId: string,
): Promise<{ cluster: string; username: string; revokeCommand: string }[]> {
  const rows = await db
    .select({ name: clusters.name, username: clusters.provisionedUsername })
    .from(clusters)
    .where(eq(clusters.orgId, orgId));
  return rows.flatMap((row) =>
    row.username === null
      ? []
      : [
          {
            cluster: row.name,
            username: row.username,
            revokeCommand: revokeCommandFor(row.username) ?? "",
          },
        ],
  );
}
