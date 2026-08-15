// SQL Server connection strings come in two shapes and customers paste both:
// URL form (mssql://user:pass@host:1433/db?encrypt=true) and the ADO form every
// Microsoft tool hands out (Server=host,1433;Database=db;User Id=u;Password=p).
// Both are accepted; parsing normalizes them into one structure the client,
// the network guard and the TLS rules all read. The stored string keeps the
// shape the owner pasted — applyMssqlTlsOverrides edits in place rather than
// converting, so what the audit trail shows is what the owner recognizes.
//
// URL parsing uses WHATWG URL on the string as-is: mssql:/sqlserver: are
// non-special schemes, so the parser preserves the authority verbatim — no
// default-port swallowing (443 survives), IPv6 hosts work, and toString gives
// the original scheme back (verified on Node 22).

export const DEFAULT_MSSQL_PORT = 1433;

export interface ParsedMssqlConnString {
  readonly form: "url" | "ado";
  readonly host: string;
  readonly port: number;
  // Initial database. Empty means the login's default database, which the
  // collector never relies on — every query is three-part qualified.
  readonly database: string;
  readonly user: string;
  readonly password: string;
  // Remaining options, keys lowercased. Encrypt / TrustServerCertificate live
  // here; unknown keys are preserved so a pasted string round-trips.
  readonly params: ReadonlyMap<string, string>;
}

const URL_SCHEMES = /^(mssql|sqlserver):$/i;

// ADO key aliases, normalized to one canonical name each.
const ADO_ALIASES: Record<string, string> = {
  server: "server",
  "data source": "server",
  address: "server",
  addr: "server",
  "network address": "server",
  database: "database",
  "initial catalog": "database",
  "user id": "user",
  uid: "user",
  user: "user",
  password: "password",
  pwd: "password",
};

// `Server=tcp:host,1433` — the protocol prefix and the comma port are ADO-isms.
function splitAdoServer(value: string): { host: string; port: number } {
  const withoutProtocol = value.replace(/^(tcp|np|lpc):/i, "");
  const [host = "", rawPort] = withoutProtocol.split(",");
  const port = Number(rawPort);
  return {
    host: host.trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_MSSQL_PORT,
  };
}

// Split an ADO string on ';', except inside a {braced} value — the quoting
// ADO uses precisely so passwords may contain ';' and '='.
function splitAdoSegments(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let braced = false;
  for (const ch of value) {
    if (ch === ";" && !braced) {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "{") braced = true;
    else if (ch === "}") braced = false;
    current += ch;
  }
  segments.push(current);
  return segments;
}

function parseAdo(value: string): ParsedMssqlConnString | null {
  if (!/(^|;)\s*(server|data source|address|addr|network address)\s*=/i.test(value)) return null;
  let host = "";
  let port = DEFAULT_MSSQL_PORT;
  let database = "";
  let user = "";
  let password = "";
  const params = new Map<string, string>();
  for (const segment of splitAdoSegments(value)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const raw = segment.slice(eq + 1).trim();
    // ADO quoting: {value} or "value" wraps a value containing ; or =.
    const unquoted = /^\{.*\}$/.test(raw)
      ? raw.slice(1, -1)
      : /^".*"$/.test(raw)
        ? raw.slice(1, -1)
        : raw;
    const canonical = ADO_ALIASES[key];
    if (canonical === "server") ({ host, port } = splitAdoServer(unquoted));
    else if (canonical === "database") database = unquoted;
    else if (canonical === "user") user = unquoted;
    else if (canonical === "password") password = unquoted;
    else params.set(key, unquoted);
  }
  if (host.length === 0) return null;
  return { form: "ado", host, port, database, user, password, params };
}

function urlOf(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!URL_SCHEMES.test(url.protocol)) return null;
  if (url.hostname.length === 0) return null;
  return url;
}

function parseUrl(value: string): ParsedMssqlConnString | null {
  const url = urlOf(value);
  if (url === null) return null;
  const port = Number(url.port);
  const params = new Map<string, string>();
  for (const [key, entry] of url.searchParams) params.set(key.toLowerCase(), entry);
  return {
    form: "url",
    host: decodeURIComponent(url.hostname),
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_MSSQL_PORT,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    params,
  };
}

export function parseMssqlConnString(value: string): ParsedMssqlConnString | null {
  if (value.length === 0 || value.length > 4096) return null;
  return parseUrl(value) ?? parseAdo(value);
}

// Scheme guard, same contract as isMongoConnString: only strings this adapter
// could actually dial — never http/file/…, and never a mongodb:// string, so
// engine detection by elimination stays unambiguous.
export function isMssqlConnString(value: string): boolean {
  return parseMssqlConnString(value) !== null;
}

// Every host the string would dial, for the network guard. One host, never SRV.
export function mssqlHosts(value: string): { hosts: string[]; isSrv: boolean } {
  const parsed = parseMssqlConnString(value);
  if (parsed === null) return { hosts: [], isSrv: false };
  return { hosts: [`${parsed.host}:${parsed.port}`], isSrv: false };
}

// The same credentials and the same options, pointed at another server (#202).
// An Availability Group names its replicas, and each keeps its own usage
// counters, so collecting from a secondary means dialling it directly with what
// the owner already gave us — the string is edited in place, keeping its form,
// so a pasted ADO string stays ADO and every option (Encrypt, the driver knobs,
// anything unknown) travels with it. The initial database is deliberately kept:
// it is where the login lands, not what the collector reads, and every query is
// three-part qualified anyway.
export function retargetMssqlConnString(value: string, host: string, port: number): string {
  const parsed = parseMssqlConnString(value);
  if (parsed === null) return value;
  if (parsed.form === "url") {
    const url = urlOf(value);
    if (url === null) return value;
    url.hostname = host;
    url.port = String(port);
    return url.toString();
  }
  const kept = splitAdoSegments(value).filter((segment) => {
    const eq = segment.indexOf("=");
    if (eq === -1) return segment.trim().length > 0;
    return ADO_ALIASES[segment.slice(0, eq).trim().toLowerCase()] !== "server";
  });
  return [`Server=${host},${port}`, ...kept.filter((segment) => segment.trim().length > 0)].join(
    ";",
  );
}

// `tcp://ag2.corp:1433` — the shape sys.availability_replicas records a
// replica's read-only routing URL in. Null for anything else, including the
// bare instance names a replica without routing configured reports, which
// cannot be dialled without guessing a port.
export function parseRoutingUrl(value: string | null): { host: string; port: number } | null {
  if (value === null) return null;
  const match = /^tcp:\/\/(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/i.exec(value.trim());
  if (match === null) return null;
  const host = (match[1] ?? "").replace(/^\[|\]$/g, "");
  if (host.length === 0) return null;
  const port = Number(match[2]);
  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_MSSQL_PORT,
  };
}

// Encrypt values across driver generations: booleans, yes/no, and the 18.x
// vocabulary (mandatory/optional/strict). "strict" is TDS 8.0 — encrypted
// before login, certificate always validated. Absent defaults ON: that is the
// current driver default and the direction a missing option has to fail in.
export type EncryptMode = "on" | "off" | "strict";

export function encryptModeOf(parsed: ParsedMssqlConnString): EncryptMode {
  const raw = parsed.params.get("encrypt")?.toLowerCase();
  if (raw === undefined) return "on";
  if (raw === "strict") return "strict";
  if (raw === "false" || raw === "no" || raw === "optional") return "off";
  return "on";
}

export function trustsServerCertificate(parsed: ParsedMssqlConnString): boolean {
  const raw = parsed.params.get("trustservercertificate")?.toLowerCase();
  return raw === "true" || raw === "yes";
}

// Rewrite one option in the string, preserving its form (URL param or ADO
// segment) and removing any casing variants so the stored string cannot carry
// a second, contradicting copy. `replacement: null` removes the option.
function withParam(value: string, key: string, replacement: string | null): string {
  const parsed = parseMssqlConnString(value);
  if (parsed === null) return value;
  if (parsed.form === "url") {
    const url = urlOf(value);
    if (url === null) return value;
    for (const existing of [...url.searchParams.keys()]) {
      if (existing.toLowerCase() === key) url.searchParams.delete(existing);
    }
    if (replacement !== null) url.searchParams.set(key, replacement);
    return url.toString();
  }
  const kept = splitAdoSegments(value)
    .filter((segment) => {
      const eq = segment.indexOf("=");
      if (eq === -1) return segment.trim().length > 0;
      return segment.slice(0, eq).trim().toLowerCase() !== key;
    })
    .join(";");
  return replacement === null ? kept : `${kept};${key}=${replacement}`;
}

// TlsOverrides → connection-string options. The mapping is narrower than
// mongo's because the driver's knobs are:
//
//   insecure                  → Encrypt=false (plaintext TDS)
//   allowInvalidCertificates  → TrustServerCertificate=true
//   allowInvalidHostnames     → NO equivalent: tedious validates the hostname
//                               as part of certificate validation and has no
//                               switch for one without the other. Consenting to
//                               it alone is refused in assertMssqlTlsEnforced
//                               with the box to tick instead, rather than
//                               silently granting the broader concession.
//
// Authoritative in both directions for the DISABLING values, like the mongo
// version: an unticked box removes a pasted Encrypt=false or
// TrustServerCertificate=true. A pasted encrypt=true or encrypt=strict is a
// strengthening statement, not a concession, and survives untouched.
export function applyMssqlTlsOverrides(
  value: string,
  overrides: {
    allowInvalidCertificates: boolean;
    allowInvalidHostnames: boolean;
    insecure: boolean;
  },
): string {
  const parsed = parseMssqlConnString(value);
  if (parsed === null) return value;
  let result = value;
  if (overrides.insecure) result = withParam(result, "encrypt", "false");
  else if (encryptModeOf(parsed) === "off") result = withParam(result, "encrypt", null);
  result = withParam(
    result,
    "trustservercertificate",
    overrides.allowInvalidCertificates ? "true" : null,
  );
  return result;
}
