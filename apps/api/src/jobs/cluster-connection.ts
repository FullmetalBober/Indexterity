import { masterKeyBytesFor } from "../config/env";
import { clusters, type Database, envKeyProvider, eq, open } from "../db";
import type { ClusterEngine, EngineSession } from "../engine/ports";
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
  // Return the session to the pool — callers must not close it.
  readonly release: () => void;
}

// Load a cluster, unseal its connection string, and lease a pooled session for
// its engine.
export async function openClusterSession(db: Database, clusterId: string): Promise<ClusterSession> {
  const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId)).limit(1);
  if (cluster === undefined) throw new ClusterGoneError(clusterId);
  let connString: string;
  try {
    connString = new TextDecoder().decode(
      await open(
        { dek: cluster.sealedDek, data: cluster.sealedData },
        envKeyProvider(masterKeyBytesFor(cluster.keyVersion)),
      ),
    );
  } catch (error) {
    throw new ClusterCredentialsError(clusterId, cluster.keyVersion, error);
  }
  const { session, release } = await acquireClusterSession(
    clusterId,
    cluster.engine,
    connString,
    cluster.tlsOverrides,
  );
  return { session, engine: cluster.engine, readOnly: cluster.readOnly, release };
}
