import { clusters, type Database, envKeyProvider, eq, open } from "../db";
import type { ClusterEngine, EngineSession } from "../engine/ports";
import { masterKeyBytesFor } from "../env";
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
  if (cluster === undefined) throw new Error(`cluster not found: ${clusterId}`);
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
  const { session, release } = await acquireClusterSession(clusterId, cluster.engine, connString);
  return { session, engine: cluster.engine, readOnly: cluster.readOnly, release };
}
