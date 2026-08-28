import { masterKeyBytesFor } from "../config/env";
import { clusters, type Database, envKeyProvider, eq, open } from "../db";
import { ObservedSession } from "../engine/observe";
import type { ClusterEngine, EngineSession } from "../engine/ports";
import { adapterFor } from "../engine/registry";
import { routeForCluster } from "../tunnel/resolve";
import type { TunnelRegistry } from "../tunnel/tunnel.registry";
import { acquireClusterSession } from "./connection-pool";

// The stored credentials would not decrypt. Always a control-plane problem —
// a wrong or half-rotated MASTER_KEY — never something the customer can fix,
// and never something a retry fixes either. Raised in place of the crypto
// layer's bare "invalid tag" so the log names the cause and the key to check.
export class ClusterCredentialsError extends Error {
  constructor(clusterId: string, keyVersion: number, cause: unknown) {
    const keyName = keyVersion <= 1 ? "MASTER_KEY" : `MASTER_KEY_V${keyVersion}`;
    super(
      `cluster ${clusterId}: stored credentials could not be decrypted — ` +
        `they were sealed with key version ${keyVersion}, so check ${keyName}`,
    );
    this.name = "ClusterCredentialsError";
    this.cause = cause;
  }
}

// The cluster was deleted between the tick being scheduled and the job running.
// Routine — offboarding does not reach into the queue — and the work is moot,
// so the task must not treat it as a failure: three retries per orphaned job,
// each printing a stack trace, and a final-failure alert addressed to the
// owners of a cluster that no longer exists.
export class ClusterGoneError extends Error {
  constructor(clusterId: string) {
    super(`cluster ${clusterId} no longer exists — nothing to do`);
    this.name = "ClusterGoneError";
  }
}

export interface ClusterSession {
  readonly session: EngineSession;
  readonly engine: ClusterEngine;
  readonly readOnly: boolean;
  // Whether this engine has reversible index invisibility
  // (`EngineCapabilities.hideIndexes`). Read here rather than at each call site
  // so the pipeline never reaches for the registry itself, and so the six
  // places that hide or un-hide branch on one fact computed once.
  //
  // False means the observe stage is statistics-only: the index keeps serving
  // every query while the window runs, the read-latency regression gate has
  // nothing to measure (nothing was hidden, so nothing can have been slowed by
  // hiding), and the evidence is the usage counters staying flat — which is
  // what `preflightDrop` already re-checks before the drop.
  readonly canHide: boolean;
  // Which databases the owner asked us to observe, or null for all of them
  // (#244). Carried for the callers that need to SAY what was in scope — the
  // filtering itself is already done by the session above, and no caller has to
  // remember to apply it.
  readonly observedDatabases: readonly string[] | null;
  // Return the session to the pool — callers must not close it.
  readonly release: () => void;
}

export interface OpenClusterOptions {
  // Lease the session WITHOUT the observe filter, so it reports every database
  // the cluster has (#244).
  //
  // One caller wants this — the screen that offers the checkboxes, whose whole
  // job is to show a database that is not being observed yet. It is an option
  // rather than a second function so that every other caller gets the filter
  // without having to know the filter exists, and so this comment is the only
  // place that has to argue for an exception.
  readonly allDatabases?: boolean;
  // The live tunnels, when this cluster is reached over one (#353). Declared
  // here rather than reached for through a module global, so a reader of this
  // signature can see that a tunnelled cluster needs one — and so a test can
  // supply a fake without remembering to reset anything afterwards.
  readonly tunnels?: TunnelRegistry;
}

// The cluster row and the credentials it was sealed with.
//
// Its own function because one caller wants the STRING rather than a session:
// re-diagnosing an existing cluster (#313) asks the adapter what these
// credentials may do, and `diagnose` takes a connection string — a pooled session
// cannot answer it, and a second copy of the unseal would be a second place for
// the key-version handling and its named error to drift.
export async function unsealCluster(
  db: Database,
  clusterId: string,
): Promise<{
  cluster: typeof clusters.$inferSelect;
  connectionString: string;
}> {
  const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId)).limit(1);
  if (cluster === undefined) throw new ClusterGoneError(clusterId);
  try {
    return {
      cluster,
      connectionString: new TextDecoder().decode(
        await open(
          { dek: cluster.sealedDek, data: cluster.sealedData },
          envKeyProvider(masterKeyBytesFor(cluster.keyVersion)),
        ),
      ),
    };
  } catch (error) {
    throw new ClusterCredentialsError(clusterId, cluster.keyVersion, error);
  }
}

// Load a cluster, unseal its connection string, and lease a pooled session for
// its engine.
export async function openClusterSession(
  db: Database,
  clusterId: string,
  options: OpenClusterOptions = {},
): Promise<ClusterSession> {
  const { cluster, connectionString: connString } = await unsealCluster(db, clusterId);
  // Brings the tunnel up on first use if this cluster has one, and is null for
  // every cluster that does not — which is all of them before #353.
  const routed = await routeForCluster(db, cluster.tunnelId, options.tunnels);
  const { session, release } = await acquireClusterSession(
    clusterId,
    cluster.engine,
    connString,
    cluster.tlsOverrides,
    routed?.proxy,
    routed?.route,
  );
  const observed = cluster.observedDatabases;
  return {
    // Unwrapped when the cluster observes everything, which is the common case and
    // every cluster connected before #244 — no wrapper, no per-collect filtering,
    // nothing to reason about.
    session:
      observed === null || options.allDatabases === true
        ? session
        : new ObservedSession(session, observed),
    engine: cluster.engine,
    readOnly: cluster.readOnly,
    canHide: adapterFor(cluster.engine).capabilities.hideIndexes,
    observedDatabases: observed,
    release,
  };
}
