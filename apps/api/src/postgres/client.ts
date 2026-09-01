// The ONLY place a PostgreSQL pool is configured — the postgres twin of
// mongo/client.ts and mssql/client.ts, and the same chokepoint argument: the
// pipeline opens the STORED string without passing through the controller's
// guardDial, so transport enforcement has to live where the pool is built or
// existing clusters keep dialling plaintext forever.
//
// It is also where the sslmode rules live rather than in conn-string.ts, for the
// same reason the mssql pair is split that way: `ALLOW_INSECURE_CLUSTER_TLS` is a
// deployment posture, and a pure string reader has no business reading env.

import { Pool } from "pg";
import { type DialProxy, NO_TLS_OVERRIDES, type TlsOverrides } from "../engine/ports";
import { pgStreamFactory } from "../engine/socks-dial";
import { allowInsecureTls, InsecureConnectionError } from "../engine/tls";
import {
  effectivePgTrust,
  MODE_RANK,
  modeForOverrides,
  type PgSslMode,
  parsePgConnString,
  sslModeOf,
} from "./conn-string";

// Fail fast on unreachable servers, the same budget as the mongo client's
// server-selection timeout and the mssql connect timeout.
const CONNECT_TIMEOUT_MS = 5000;
// The budget every statement gets unless it asks for another. NO LONGER sized
// for a build (#410): a build now raises it for itself through
// `execute(..., { build: true })`, because one number could not be right for
// both. This one is what a catalog read, a `pg_stat_statements` sweep or a drop
// may take — generous for all three, and deliberately not stretched to cover
// `CREATE INDEX CONCURRENTLY` on a hundred-gigabyte table, which is what it used
// to be reasoned about as and what made a genuinely long build impossible.
const STATEMENT_TIMEOUT_MS = 900_000;
// One session serves one collect at a time, and a pool is opened PER DATABASE
// here rather than one for the cluster, so this number is multiplied by however
// many databases are observed. Kept small deliberately: the customer's
// connection budget is not ours to spend, and `max_connections` defaults to 100.
const POOL_MAX = 2;

// One sentence per rung, naming the box rather than the mode. `disable` covers
// the string that names no sslmode at all, because that is what this driver does
// with one — see effectivePgTrust.
const ADVICE: Readonly<Record<PgSslMode, string>> = {
  disable:
    "That is plaintext, and it is also what a string naming no sslmode at all does on this driver — tick “connect without TLS” to store it anyway, or set sslmode=verify-full",
  allow:
    "sslmode=allow lets the server decline TLS, so the connection may end up in plaintext — set sslmode=verify-full",
  prefer: "sslmode=prefer falls back to plaintext without saying so — set sslmode=verify-full",
  require:
    "sslmode=require with uselibpqcompat=true encrypts but validates no certificate at all — tick “allow invalid certificates” to accept that, or drop the compat flag",
  "verify-ca":
    "sslmode=verify-ca checks the chain but not the hostname — tick “allow invalid hostnames” to accept that, or set sslmode=verify-full",
  "verify-full": "",
};

// Throws when the string would not connect over TLS, or when it turns off a
// check the owner did not consent to. Authoritative in the WEAKENING direction
// only, exactly like the mongo and mssql versions: a string stronger than the
// ticked boxes is a decision to be safer than required and is left alone.
export function assertPgTlsEnforced(
  value: string,
  overrides: TlsOverrides = NO_TLS_OVERRIDES,
): void {
  if (allowInsecureTls()) return;
  const parsed = parsePgConnString(value);
  // Unparseable is not a TLS verdict; isPgConnString refuses it first.
  if (parsed === null) return;
  // The one concession this driver cannot express. Refused rather than upgraded
  // to the certificate box behind the owner's back: consenting to an unchecked
  // HOSTNAME is not consenting to an unchecked certificate.
  if (overrides.allowInvalidHostnames && !overrides.allowInvalidCertificates) {
    throw new InsecureConnectionError(
      "“allow invalid hostnames” on its own cannot be honoured on PostgreSQL: the " +
        "driver's verify-ca mode requires a CA file, and a connection string has " +
        "nowhere to carry one. Use the invalid-certificates option instead if that " +
        "is intended, or use a certificate whose name matches the host",
    );
  }
  const allowed = modeForOverrides(overrides);
  if (effectivePgTrust(parsed) >= MODE_RANK[allowed]) return;
  const found = sslModeOf(parsed);
  throw new InsecureConnectionError(
    `refusing to connect: this string reaches sslmode=${found} where ` +
      `sslmode=${allowed} was agreed to. ${ADVICE[found]}`,
  );
}

// Build the pool from the parsed string rather than handing the driver the raw
// one, so the hosts the network guard vetted are exactly the hosts dialled.
//
// `connectionString` is still passed through for the TLS half: node-pg reads
// sslmode and uselibpqcompat off it, and reproducing that decision as an `ssl`
// object here would be a second implementation of the rules assertPgTlsEnforced
// just checked — the two could then disagree about one string.
export async function pgPool(
  connectionString: string,
  overrides?: TlsOverrides,
  database?: string,
  proxy?: DialProxy,
): Promise<Pool> {
  assertPgTlsEnforced(connectionString, overrides);
  const parsed = parsePgConnString(connectionString);
  if (parsed === null) throw new Error("not a PostgreSQL connection string");
  const pool = new Pool({
    connectionString,
    // Every host the string named, so libpq's own failover still applies —
    // narrowing to one is the collector's job when it reads a single standby.
    ...(database === undefined ? {} : { database }),
    max: POOL_MAX,
    min: 0,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // Named so a DBA reading pg_stat_activity knows who is asking. The same
    // string mssql sets as appName.
    application_name: "indexterity",
    // node-pg is the one of the three that cannot take a connect-on-create
    // SOCKS client: it calls stream.connect(port, host) AFTER this factory
    // returns. See engine/socks-dial.ts for what that costs and why the shim
    // is a plain Duplex.
    ...(proxy === undefined ? {} : { stream: pgStreamFactory(proxy) }),
  });
  // A pg Pool is an EventEmitter that emits 'error' when an IDLE client's
  // connection dies, and an EventEmitter 'error' with no listener is an uncaught
  // exception — so a customer's database restarting while one of its pooled
  // sessions sat idle took THIS PROCESS down. Measured on postgres 17: check a
  // client out, release it, terminate its backend, and the process exits on
  // `error: terminating connection due to administrator command` with no frame of
  // ours in it. Sessions are held for five idle minutes (jobs/connection-pool.ts),
  // so the window is most of the time a cluster is connected at all.
  //
  // The control-plane pool has had this handler since it took graphile-worker's
  // pgPool (db/client.ts, where the same reasoning is written out); the three
  // customer pools built here never got one. pg terminates and evicts the dead
  // client itself, so the handler's job is to exist and to say whose database it
  // was — the cluster is not named here because this function is not told, and
  // the pass that touches the cluster next reports it through the ordinary
  // unreachable path.
  pool.on("error", (error) => {
    console.error(`cluster postgres pool: idle client errored: ${String(error)}`);
  });
  // The other half of the same crash: a client CHECKED OUT of the pool emits
  // connection errors on itself, not on the pool. pg re-raises the failure from
  // the client's next query — which is where the customer boundary in
  // postgres/connection.ts classifies it (#420) — so this listener only has to
  // keep the emitter from throwing.
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error(`cluster postgres pool: active client errored: ${String(error)}`);
    });
  });
  // A pool hands out connections lazily, so nothing above has dialled yet — and
  // a bad password or an unreachable host must surface HERE rather than at the
  // first query, which is what every caller's error handling expects.
  const probe = await pool.connect();
  probe.release();
  return pool;
}
