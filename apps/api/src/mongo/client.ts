import { MongoClient } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";

// Fail fast on unreachable clusters: 5s server selection instead of the driver's
// 30s default, so requests surface a 502 quickly.
const SERVER_SELECTION_TIMEOUT_MS = 5000;

// Options that keep TLS switched on while turning off the part that makes it
// worth having. A connection nobody validates the certificate of is a connection
// anyone in the path can be, so these count as "not TLS" for enforcement.
const VALIDATION_DISABLED = [
  "tlsinsecure",
  "tlsallowinvalidcertificates",
  "tlsallowinvalidhostnames",
];

export class InsecureConnectionError extends Error {}

// Self-hosted installs and the dev stack point at a local mongod with no
// certificate. Deliberately its OWN switch rather than riding on
// ALLOW_PRIVATE_CLUSTER_TARGETS: a VPC-peered or PrivateLink Atlas cluster is a
// private address that must still be forced to TLS, so coupling a transport rule
// to an addressing rule would quietly weaken real deployments.
export function allowInsecureTls(): boolean {
  return process.env.ALLOW_INSECURE_CLUSTER_TLS === "true";
}

// Whether this string would actually connect over validated TLS.
//
// `tls` and `ssl` are aliases in the driver, and either one present means the
// string has answered the question itself. With neither, the scheme decides:
// mongodb+srv:// defaults TLS on, mongodb:// defaults it off — which is why
// Atlas customers are encrypted by accident of the scheme and a pasted
// mongodb://host:27017/db is plaintext, credentials and all.
export function usesValidatedTls(value: string): boolean {
  let parsed: ConnectionString;
  try {
    parsed = new ConnectionString(value);
  } catch {
    // Unparseable is not a TLS verdict. isMongoConnString rejects it first and
    // says so more usefully than this would.
    return false;
  }
  const params = parsed.searchParams;
  for (const [key, raw] of params) {
    if (VALIDATION_DISABLED.includes(key.toLowerCase()) && raw.toLowerCase() === "true") {
      return false;
    }
  }
  const explicit = params.get("tls") ?? params.get("ssl");
  if (explicit !== null) return explicit.toLowerCase() === "true";
  return parsed.isSRV;
}

export function assertTlsEnforced(value: string): void {
  if (allowInsecureTls() || usesValidatedTls(value)) return;
  throw new InsecureConnectionError(
    "refusing to connect without validated TLS: add tls=true (and drop " +
      "tlsInsecure / tlsAllowInvalidCertificates / tlsAllowInvalidHostnames) — " +
      "set ALLOW_INSECURE_CLUSTER_TLS=true if this deployment manages databases " +
      "over a trusted network",
  );
}

// The ONLY place a driver client is constructed.
//
// Enforcement has to live here rather than in the controller's guardDial, which
// is what already vets addresses. guardDial runs on checkConnection and
// createCluster; the worker never touches it — jobs/connection-pool.ts opens the
// STORED string directly — so a guard at onboarding would refuse new plaintext
// clusters and let every existing one keep dialling plaintext forever. One
// chokepoint also means a fifth call site cannot forget: there were four, and
// none of them said anything about transport.
//
// It refuses rather than silently setting tls=true. A server with no TLS would
// then fail its handshake instead, turning a precise refusal into an opaque
// driver error, and a string that says tls=false is a statement worth
// contradicting out loud.
export function mongoClient(uri: string): MongoClient {
  assertTlsEnforced(uri);
  return new MongoClient(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
}
