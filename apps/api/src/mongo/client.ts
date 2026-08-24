import { MongoClient } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";
import { workerEnv } from "../config/env";
import { NO_TLS_OVERRIDES, type TlsOverrides } from "../engine/ports";
import { allowInsecureTls, InsecureConnectionError } from "../engine/tls";

// Fail fast on unreachable clusters: 5s server selection instead of the driver's
// 30s default, so requests surface a 502 quickly.
const SERVER_SELECTION_TIMEOUT_MS = 5000;

// Return a socket to the operating system after this long unused. The driver
// keeps pooled sockets indefinitely by default, and a session here outlives the
// job that opened it — connection-pool.ts holds one per cluster for five idle
// minutes so the next job skips a fresh handshake. That is worth keeping, but
// holding every socket the busiest moment needed for the whole five minutes is
// not: this returns the surplus while leaving the session itself warm. A
// reconnect costs one handshake, which is what the 5s selection timeout above
// already budgets for.
const MAX_IDLE_TIME_MS = 60_000;

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

// Read per call rather than captured at module load: the schema is validated at
// boot, and reading through it keeps one answer for what the environment says.
export function maxPoolSize(): number {
  return workerEnv().MONGO_MAX_POOL_SIZE;
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
  return new MongoClient(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    // Bounded on purpose. The driver's default of 100 per client is a ceiling
    // nothing here approaches — the collectors fan out per replica-set member,
    // and each member has its own client — while the cost of it is paid twice:
    // by this process, which holds a session per connected cluster, and by the
    // customer's mongod, whose connection budget is not ours to spend.
    maxPoolSize: maxPoolSize(),
    maxIdleTimeMS: MAX_IDLE_TIME_MS,
  });
}
