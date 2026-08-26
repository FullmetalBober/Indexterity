// The ONLY place a SQL Server connection pool is configured — the mssql twin of
// mongo/client.ts, and the same chokepoint argument: the worker opens the
// STORED string without passing through the controller's guardDial, so
// transport enforcement has to live where the pool is built or existing
// clusters keep dialling plaintext forever.

import type net from "node:net";
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
// One budget for every statement — the driver has no per-request override.
// Sized for the slowest legitimate statement, which is not a DMV read but the
// unhide path's ALTER INDEX … REBUILD of a large index. Fifteen minutes is
// generous for anything the collector runs and honest about what a rebuild on
// a hundred-gigabyte table costs.
const REQUEST_TIMEOUT_MS = 900_000;
// One session serves one collect at a time; a handful of sockets is plenty,
// and the customer's connection budget is not ours to spend.
const POOL_MAX = 4;

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
    pool: { max: POOL_MAX, min: 0 },
    options: {
      // "strict" is TDS 8.0 and the driver accepts it verbatim.
      encrypt: mode === "strict" ? ("strict" as unknown as boolean) : mode === "on",
      trustServerCertificate:
        trustsServerCertificate(parsed) && (overrides?.allowInvalidCertificates ?? false),
      // A cluster's read-only MODE is enforced structurally in the executor,
      // not here: a readOnly cluster still needs to write during an approved
      // apply. This flag is about which replica will accept the connection at
      // all, which is why only the member dials set it.
      readOnlyIntent: dial?.readOnlyIntent ?? false,
      appName: "indexterity",
      // Cast because @types/mssql declares `connector` as taking no arguments,
      // and tedious 20 calls it with the destination: connection.js:1259 passes
      // `connectOpts` (host, port, localAddress) into whatever custom connector
      // it was given. Verified against a live SQL Server 2022 — a connector
      // written to the declared signature would have nowhere to dial.
      ...(dial?.proxy === undefined
        ? {}
        : { connector: mssqlConnector(dial.proxy) as unknown as () => Promise<net.Socket> }),
    },
  };
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
  const pool = new mssql.ConnectionPool(mssqlConfig(parsed, overrides, dial));
  await pool.connect();
  return pool;
}
