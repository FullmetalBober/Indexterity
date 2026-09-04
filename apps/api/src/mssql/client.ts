// The ONLY place a SQL Server connection pool is configured — the mssql twin of
// mongo/client.ts, and the same chokepoint argument: the worker opens the
// STORED string without passing through the controller's guardDial, so
// transport enforcement has to live where the pool is built or existing
// clusters keep dialling plaintext forever.

import mssql from "mssql";
import { type DialProxy, NO_TLS_OVERRIDES, type TlsOverrides } from "../engine/ports";
import { mssqlConnector } from "../engine/socks-dial";
import { allowInsecureTls, InsecureConnectionError } from "../engine/tls";
import {
  encryptModeOf,
  type ParsedMssqlConnString,
  parseMssqlConnString,
  trustsServerCertificate,
} from "./conn-string";

// Fail fast on unreachable servers, same budget as the mongo client's 5s
// server-selection timeout.
const CONNECT_TIMEOUT_MS = 5000;
// The budget every request gets unless it asks for another.
//
// The note here used to say the driver has no per-request override, and that is
// not true of mssql 12: `new Request(pool, { requestTimeout })` is honoured, and
// a build now uses it (#410). So this is no longer sized for the slowest
// statement any adapter ever makes — it is what a DMV read may take, which is
// what the collector actually runs. A REBUILD or a CREATE asks for the build
// budget instead, because sizing one number for both is what made a genuinely
// long build impossible.
const REQUEST_TIMEOUT_MS = 900_000;
// One session serves one collect at a time; a handful of sockets is plenty,
// and the customer's connection budget is not ours to spend.
const POOL_MAX = 4;
// How long a statement may wait for one of those sockets before the pool gives
// up on it. tarn's default is 30 s and node-mssql does not set it, which is how
// the production Prod MSSQL collect died: four sockets held by Query Store scans
// an abandoned pass had left running, a fifth statement waited 30 s, and the
// pass failed with tarn's "operation timed out for an unknown reason" (#454).
// A wait may legitimately be as long as the statements ahead of it, so it gets
// the statement budget; a pass with a shorter wall clock is stopped by that
// clock first, which is the named outcome. The connection maps the timeout to
// PoolExhaustedError — see mssql/connection.ts.
export const POOL_ACQUIRE_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

export function assertMssqlTlsEnforced(
  value: string,
  overrides: TlsOverrides = NO_TLS_OVERRIDES,
): void {
  if (allowInsecureTls()) return;
  const parsed = parseMssqlConnString(value);
  // Unparseable is not a TLS verdict; isMssqlConnString refuses it first.
  if (parsed === null) return;
  if (encryptModeOf(parsed) === "off" && !overrides.insecure) {
    throw new InsecureConnectionError(
      "refusing to connect without encryption: remove Encrypt=false (the driver " +
        "encrypts by default) — set ALLOW_INSECURE_CLUSTER_TLS=true if this " +
        "deployment manages databases over a trusted network",
    );
  }
  if (trustsServerCertificate(parsed) && !overrides.allowInvalidCertificates) {
    throw new InsecureConnectionError(
      "refusing to connect with TrustServerCertificate=true: encryption whose " +
        "certificate is not checked is a connection anyone in the path can be. " +
        "Turn on the invalid-certificates option when connecting the cluster if " +
        "that is intended, or drop it from the connection string",
    );
  }
  if (overrides.allowInvalidHostnames && !overrides.allowInvalidCertificates) {
    throw new InsecureConnectionError(
      "SQL Server's driver validates the hostname as part of certificate " +
        "validation and cannot skip one without the other. Use the " +
        "invalid-certificates option instead if that is intended",
    );
  }
}

// Build the driver config from the parsed string. The string is parsed by our
// own parser rather than handed to the driver, so the hosts the network guard
// vetted are exactly the hosts dialled.
export interface MssqlDialOptions {
  // ApplicationIntent=ReadOnly. Set only when dialling an Availability Group
  // replica (#202): a secondary configured ALLOW_CONNECTIONS = READ_ONLY
  // refuses a plain connection outright — Msg 978, verified on 2022, and it
  // refuses at the first three-part read even when the connection named no
  // initial database — while a replica that allows ALL accepts read intent
  // happily. NOT inferred from a pasted ApplicationIntent, which the driver
  // config has always ignored: honouring one now would silently break the
  // apply path for a cluster that connects fine today.
  readonly readOnlyIntent?: boolean;
  // Route this dial through a SOCKS5 proxy — a tunnel (#353) or a relay agent
  // (#272). tedious takes a `connector` that is handed the destination up
  // front, so unlike node-pg this drops straight in.
  //
  // One caveat that belongs here rather than in a wiki page: the instance-name
  // lookup tedious can do BEFORE connecting speaks UDP 1434 on the HOST's
  // network and is not routed through this. A SQL Server reached over a tunnel
  // has to be addressed by port.
  readonly proxy?: DialProxy;
}

export function mssqlConfig(
  parsed: ParsedMssqlConnString,
  overrides?: TlsOverrides,
  dial?: MssqlDialOptions,
): mssql.config {
  const mode = encryptModeOf(parsed);
  return {
    server: parsed.host,
    port: parsed.port,
    database: parsed.database.length > 0 ? parsed.database : undefined,
    user: parsed.user.length > 0 ? parsed.user : undefined,
    password: parsed.password.length > 0 ? parsed.password : undefined,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    pool: { max: POOL_MAX, min: 0, acquireTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS },
    options: {
      // "strict" is TDS 8.0 and the driver accepts it verbatim.
      encrypt: mode === "strict" ? "strict" : mode === "on",
      trustServerCertificate:
        trustsServerCertificate(parsed) && (overrides?.allowInvalidCertificates ?? false),
      // A cluster's read-only MODE is enforced structurally in the executor,
      // not here: a readOnly cluster still needs to write during an approved
      // apply. This flag is about which replica will accept the connection at
      // all, which is why only the member dials set it.
      readOnlyIntent: dial?.readOnlyIntent ?? false,
      appName: "indexterity",
      // No cast. tedious declares `connector` as taking no arguments and calls
      // it with the destination anyway (connection.js:1259 passes host, port and
      // localAddress), which used to be asserted past here. `mssqlConnector`
      // declares its argument OPTIONAL instead, which IS assignable to a
      // no-argument type and keeps the compiler checking the rest of the
      // signature — the return type especially, which is the half that would
      // actually break a dial. Verified against a live SQL Server 2022.
      ...(dial?.proxy === undefined ? {} : { connector: mssqlConnector(dial.proxy) }),
    },
  };
}

// The pool, configured and guarded but NOT yet dialled.
//
// Split out from `mssqlPool` so the listener below can be asserted without a
// server: `connect()` needs one, building the pool does not. Exported for
// client.test.ts and for nothing else.
export function buildMssqlPool(
  parsed: ParsedMssqlConnString,
  overrides?: TlsOverrides,
  dial?: MssqlDialOptions,
): mssql.ConnectionPool {
  const pool = new mssql.ConnectionPool(mssqlConfig(parsed, overrides, dial));
  // A mssql.ConnectionPool is an EventEmitter, and an 'error' with no listener is
  // an uncaught exception — so this took the process down. #420 fixed the same
  // CLASS of crash on the pg pools; #424 asked whether this pool shared it, and
  // the answer is yes with a different mechanism, so the shape of the fix differs
  // too. Measured against SQL Server 2022 (mssql 12, tedious 19), driving this
  // module's own `mssqlConfig` and pool construction:
  //
  //   IDLE, server gone       stop the server with one connection sitting idle in
  //                           the pool: nothing. Survived 30s, and instrumenting
  //                           `pool.emit` showed tedious emitted NO events at all.
  //   IDLE, session killed     the exact analogue of #420's `pg_terminate_backend`
  //                           — `KILL <spid>` from a second connection, with the
  //                           victim verified present in `sys.dm_exec_sessions`
  //                           before and GONE after: again nothing, and the pool's
  //                           next query succeeded.
  //   REQUEST IN FLIGHT        the one that kills the process. The query itself
  //                           rejects cleanly (`RequestError: socket hang up`,
  //                           ECONNRESET) and then, ~1ms later, tedious dispatches
  //                           a late `socketError` into a connection already in
  //                           state 'Final', emits `Error: No event 'socketError'
  //                           in state 'Final'` on the Connection, and node-mssql
  //                           re-emits it on THIS pool (connection-pool.js:112).
  //                           Unhandled, the process exits.
  //
  // Which is worse than the pg one to find by reading: the failure arrives AFTER a
  // clean, correctly-handled rejection, so the caller's error handling looks like
  // it worked and the process dies anyway.
  //
  // ONE listener, not the two postgres/client.ts carries. Both of those exist
  // because pg splits the cases — the pool emits for idle clients and a
  // checked-out client emits on itself — whereas node-mssql funnels the tedious
  // Connection's error onto the pool, so the pool is the only emitter there is.
  // Verified in both directions: without this line the probe exits 1, with it the
  // same probe handles the error and survives. The idle half pg needs has nothing
  // to attach to here and is deliberately absent rather than added for symmetry.
  //
  // Nothing to repair, so the handler only records: tedious has already failed the
  // request and the connection is in its terminal state, and the pass that touches
  // this cluster next reports it through the ordinary unreachable path. The cluster
  // is not named because this function is not told which one it is.
  pool.on("error", (error) => {
    console.error(`cluster mssql pool: ${String(error)}`);
  });
  return pool;
}

export async function mssqlPool(
  connectionString: string,
  overrides?: TlsOverrides,
  dial?: MssqlDialOptions,
): Promise<mssql.ConnectionPool> {
  assertMssqlTlsEnforced(connectionString, overrides);
  const parsed = parseMssqlConnString(connectionString);
  if (parsed === null) {
    throw new Error("not a SQL Server connection string");
  }
  const pool = buildMssqlPool(parsed, overrides, dial);
  await pool.connect();
  return pool;
}
