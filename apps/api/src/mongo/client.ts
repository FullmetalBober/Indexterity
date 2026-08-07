import { MongoClient } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";

// Fail fast on unreachable clusters: 5s server selection instead of the driver's
// 30s default, so requests surface a 502 quickly.
const SERVER_SELECTION_TIMEOUT_MS = 5000;

// The driver options that keep TLS switched on while turning off the part that
// makes it worth having, each paired with the consent that permits it. A
// connection nobody validates the certificate of is a connection anyone in the
// path can be — so these are refused by default and allowed only against a
// decision the owner made on purpose, as a checkbox on the connect form.
//
// One entry per option rather than a single "insecure" toggle, because they are
// not the same concession: a private CA fails certificate validation with a
// perfectly correct hostname, and an SSH tunnel fails the hostname check with a
// genuinely valid certificate. Collapsing them would make everyone give up both.
const VALIDATION_DISABLED: readonly [string, keyof TlsOverrides][] = [
  ["tlsallowinvalidcertificates", "allowInvalidCertificates"],
  ["tlsallowinvalidhostnames", "allowInvalidHostnames"],
  ["tlsinsecure", "insecure"],
];

export class InsecureConnectionError extends Error {}

// Which TLS checks this particular cluster's owner chose to turn off. Recorded
// on the cluster row, so the dial is verified against a decision rather than
// against whatever the string it was handed happens to contain.
export interface TlsOverrides {
  readonly allowInvalidCertificates: boolean;
  readonly allowInvalidHostnames: boolean;
  readonly insecure: boolean;
}

export const NO_TLS_OVERRIDES: TlsOverrides = {
  allowInvalidCertificates: false,
  allowInvalidHostnames: false,
  insecure: false,
};

// Self-hosted installs and the dev stack point at a local mongod with no
// certificate. Deliberately its OWN switch rather than riding on
// ALLOW_PRIVATE_CLUSTER_TARGETS: a VPC-peered or PrivateLink Atlas cluster is a
// private address that must still be forced to TLS, so coupling a transport rule
// to an addressing rule would quietly weaken real deployments.
export function allowInsecureTls(): boolean {
  return process.env.ALLOW_INSECURE_CLUSTER_TLS === "true";
}

// Whether the transport is encrypted at all.
//
// `tls` and `ssl` are aliases in the driver, and either one present means the
// string has answered the question itself. With neither, the scheme decides:
// mongodb+srv:// defaults TLS on, mongodb:// defaults it off — which is why
// Atlas customers are encrypted by accident of the scheme and a pasted
// mongodb://host:27017/db is plaintext, credentials and all.
export function usesTls(value: string): boolean {
  let parsed: ConnectionString;
  try {
    parsed = new ConnectionString(value);
  } catch {
    // Unparseable is not a TLS verdict. isMongoConnString rejects it first and
    // says so more usefully than this would.
    return false;
  }
  const explicit = parsed.searchParams.get("tls") ?? parsed.searchParams.get("ssl");
  if (explicit !== null) return explicit.toLowerCase() === "true";
  return parsed.isSRV;
}

// Validation-disabling options the string switches on WITHOUT a matching
// consent. Named rather than counted, so the refusal can say which box to tick.
export function unconsentedTlsOverrides(
  value: string,
  overrides: TlsOverrides = NO_TLS_OVERRIDES,
): string[] {
  let parsed: ConnectionString;
  try {
    parsed = new ConnectionString(value);
  } catch {
    return [];
  }
  const unconsented: string[] = [];
  for (const [param, consent] of VALIDATION_DISABLED) {
    for (const [key, raw] of parsed.searchParams) {
      if (key.toLowerCase() !== param || raw.toLowerCase() !== "true") continue;
      if (!overrides[consent]) unconsented.push(key);
    }
  }
  return unconsented;
}

// Write the owner's choices into the string, so ticking a checkbox is enough and
// nobody has to hand-edit a connection string to match a box they just ticked.
//
// The checkboxes are authoritative in BOTH directions: an option left unticked
// is removed even if it was pasted in. Otherwise the form would show three
// cleared boxes above a string that quietly disables all three, which is a worse
// lie than refusing would have been.
export function applyTlsOverrides(value: string, overrides: TlsOverrides): string {
  let parsed: ConnectionString;
  try {
    parsed = new ConnectionString(value);
  } catch {
    // Not ours to fix — isMongoConnString refuses it first, and more usefully.
    return value;
  }
  for (const [param, consent] of VALIDATION_DISABLED) {
    // Case-insensitively, because the driver reads the params that way and a
    // pasted `tlsAllowInvalidCertificates` must not survive next to the
    // lowercase one we would add.
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase() === param) parsed.searchParams.delete(key);
    }
    if (overrides[consent]) parsed.searchParams.set(param, "true");
  }
  return parsed.toString();
}

export function assertTlsEnforced(value: string, overrides: TlsOverrides = NO_TLS_OVERRIDES): void {
  if (allowInsecureTls()) return;
  if (!usesTls(value)) {
    throw new InsecureConnectionError(
      "refusing to connect without TLS: add tls=true — set " +
        "ALLOW_INSECURE_CLUSTER_TLS=true if this deployment manages databases " +
        "over a trusted network",
    );
  }
  const unconsented = unconsentedTlsOverrides(value, overrides);
  if (unconsented.length === 0) return;
  throw new InsecureConnectionError(
    `refusing to connect with ${unconsented.join(" and ")}: TLS whose certificate ` +
      "is not checked is a connection anyone in the path can be. Turn the matching " +
      "option on when connecting the cluster if that is intended, or drop it from " +
      "the connection string",
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
//
// `overrides` defaults to nothing turned off, so a caller that forgets them gets
// the strict rule rather than a quiet exemption — the direction a default has to
// fail in.
export function mongoClient(uri: string, overrides: TlsOverrides = NO_TLS_OVERRIDES): MongoClient {
  assertTlsEnforced(uri, overrides);
  return new MongoClient(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
}
