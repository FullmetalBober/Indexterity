import { and, clusterNamespaces, type Database, eq, inArray } from "../db";
import { workloadKey } from "../engine/ports";

// The namespace dimension behind `latency_samples` (#551), written and read here
// and nowhere else.
//
// A sample row carries `namespace_id` and nothing else about where it came from.
// The collector resolves names to ids as it writes, and a reader that has to name
// a collection resolves ids back to names once per namespace. Never once per row:
// a join that puts the names back on every sample ships the bytes the dimension
// exists to save (D145).

export interface Namespace {
  readonly database: string;
  readonly collection: string;
}

// The id for each namespace, creating the ones this cluster has not had before.
// Keyed by `workloadKey`, which is how every caller already keys a namespace.
//
// Read-then-insert rather than a blind upsert, for two reasons. An identity key
// spends a sequence value on every attempted insert, including the ones a
// conflict discards, and this runs on every collect for every namespace. And the
// read is one indexed range scan on `cluster_namespaces_identity`, O(namespaces).
export async function namespaceIds(
  db: Database,
  clusterId: string,
  wanted: readonly Namespace[],
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  if (wanted.length === 0) return ids;
  const remember = (rows: readonly { id: number; database: string; collection: string }[]) => {
    for (const row of rows) ids.set(workloadKey(row.database, row.collection), row.id);
  };
  const byCluster = eq(clusterNamespaces.clusterId, clusterId);
  const columns = {
    id: clusterNamespaces.id,
    database: clusterNamespaces.database,
    collection: clusterNamespaces.collection,
  };

  remember(await db.select(columns).from(clusterNamespaces).where(byCluster));

  const missing = new Map<string, Namespace>();
  for (const namespace of wanted) {
    const key = workloadKey(namespace.database, namespace.collection);
    if (!ids.has(key)) missing.set(key, namespace);
  }
  if (missing.size === 0) return ids;

  await db
    .insert(clusterNamespaces)
    .values(
      [...missing.values()].map((namespace) => ({
        clusterId,
        database: namespace.database,
        collection: namespace.collection,
      })),
    )
    // Two collects for one cluster can overlap — a scheduled tick and the one
    // that fires on connect. The loser finds its row already there.
    .onConflictDoNothing();
  // Re-read rather than trusting `returning`, which skips whatever the conflict
  // dropped. Narrowed to the collections that were missing, so a cluster that
  // gained one does not re-read the other few hundred.
  remember(
    await db
      .select(columns)
      .from(clusterNamespaces)
      .where(
        and(
          byCluster,
          inArray(
            clusterNamespaces.collection,
            [...missing.values()].map((namespace) => namespace.collection),
          ),
        ),
      ),
  );
  return ids;
}

// The names behind a set of ids, for a reader that grouped its samples by id.
//
// By the ids the samples referenced rather than by cluster, on D145's reasoning:
// the sample read already decided which namespaces matter, and a dictionary of
// the rest would be bytes nobody asked for.
export async function namespaceNames(
  db: Database,
  ids: Iterable<number>,
): Promise<Map<number, Namespace>> {
  const wanted = [...new Set(ids)];
  const names = new Map<number, Namespace>();
  if (wanted.length === 0) return names;
  const rows = await db
    .select({
      id: clusterNamespaces.id,
      database: clusterNamespaces.database,
      collection: clusterNamespaces.collection,
    })
    .from(clusterNamespaces)
    .where(inArray(clusterNamespaces.id, wanted));
  for (const row of rows) names.set(row.id, { database: row.database, collection: row.collection });
  return names;
}
