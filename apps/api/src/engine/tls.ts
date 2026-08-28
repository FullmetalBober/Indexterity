import { workerEnv } from "../config/env";

// Transport enforcement, shared by every adapter.
//
// The shapes the ports are written in — TlsOverrides and NO_TLS_OVERRIDES —
// are in ./ports, because they appear in EngineAdapter's signatures. What is
// here is the enforcement around them: the deployment-wide escape hatch, and
// the refusal every adapter raises when a string would dial in the clear.
//
// This lived in mongo/client.ts until #329, for no better reason than MongoDB
// being the first adapter written. None of it is a MongoDB concept: the other
// two engines refuse on their own driver's rules (postgres/client.ts's sslmode
// ladder, mssql/client.ts's Encrypt / TrustServerCertificate pair) and raise
// exactly this error when they do.

// Refusing to dial. A deployment posture rather than a driver failure, so the
// controller maps it to a 4xx and the jobs report it rather than retrying.
export class InsecureConnectionError extends Error {}

// Self-hosted installs and the dev stack point at a local server with no
// certificate. Deliberately its OWN switch rather than riding on
// ALLOW_PRIVATE_CLUSTER_TARGETS: a VPC-peered or PrivateLink cluster is a
// private address that must still be forced to TLS, so coupling a transport
// rule to an addressing rule would quietly weaken real deployments.
//
// Read per call rather than captured at module load: the schema is validated at
// boot, and reading through it keeps one answer for what the environment says.
export function allowInsecureTls(): boolean {
  return workerEnv().ALLOW_INSECURE_CLUSTER_TLS;
}
