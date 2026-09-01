// PostgreSQL connection strings come in two shapes and customers paste both:
// the URI form (postgresql://user:pass@host:5432/db?sslmode=verify-full) and
// libpq's keyword/value form (host=db.corp port=5432 dbname=app user=u
// password=p sslmode=verify-full). Both are accepted; parsing normalizes them
// into one structure the client, the network guard and the TLS rules all read.
// The stored string keeps the shape the owner pasted — applyPgTlsOverrides edits
// in place rather than converting, so what the audit trail shows is what the
// owner recognizes. Same contract as mssql/conn-string.ts, which is the
// reference for this file.
//
// WHATWG URL is deliberately NOT used here, and the reason is measured rather
// than stylistic: `postgresql:` is a non-special scheme, so single-host strings
// parse correctly (port 443 survives, `[::1]` keeps its brackets) — but libpq's
// MULTI-HOST form is a comma list inside the authority, and
// `new URL("postgresql://u:p@h1:5432,h2:5433/db")` throws ERR_INVALID_URL. A
// throw there would make an ordinary HA string unparseable, which `isConnString`
// would then report as "not a PostgreSQL string" — a refusal naming the wrong
// problem. Hand-splitting is the only way to see every host, and seeing every
// host is the whole job as far as the network guard is concerned.

import type { TlsOverrides } from "../engine/ports";

export const DEFAULT_PG_PORT = 5432;

// sslmode, in libpq's order of increasing strength. In libpq, `require`
// encrypts and validates NOTHING (its long-standing footgun — it means "I insist
// on TLS", not "I insist on a trustworthy peer"), `verify-ca` validates the chain
// but not the hostname, and `verify-full` validates both.
//
// The driver does NOT implement those semantics, and this is measured against
// pg 8.22.0 rather than read from libpq's documentation — see effectivePgTrust
// below, which is where the difference is handled. Getting this wrong is not a
// cosmetic bug: it decides whether a checkbox an owner ticked does anything.
export type PgSslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";

const SSL_MODES: readonly PgSslMode[] = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
];

interface PgHost {
  readonly host: string;
  readonly port: number;
}

export interface ParsedPgConnString {
  readonly form: "uri" | "keyword";
  // Every host the string would dial, in order. libpq takes a comma list and
  // tries them in turn, so a string can name a whole HA pair — and the network
  // guard has to vet all of them, not the first.
  readonly hosts: readonly PgHost[];
  // Initial database. Empty means libpq's default (the user's own name), which
  // the collector never relies on: it enumerates databases and reconnects.
  readonly database: string;
  readonly user: string;
  readonly password: string;
  // Remaining options, keys lowercased. sslmode lives here; unknown keys are
  // preserved so a pasted string round-trips.
  readonly params: ReadonlyMap<string, string>;
}

const URI_SCHEME = /^(postgresql|postgres):\/\//i;

// `host:port`, `[::1]:port`, or a bare host. Returns null for an empty host,
// which is how a trailing comma or a socket-only string is rejected.
function parseHost(value: string): PgHost | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed !== null) {
    const host = bracketed[1] ?? "";
    if (host.length === 0) return null;
    return { host, port: portOf(bracketed[2]) };
  }
  // A bare IPv6 address contains colons and no brackets, which is unambiguous
  // only because a port needs the brackets to be told apart from a group.
  if ((trimmed.match(/:/g)?.length ?? 0) > 1) return { host: trimmed, port: DEFAULT_PG_PORT };
  const [host = "", rawPort] = trimmed.split(":");
  if (host.length === 0) return null;
  return { host: decodeURIComponent(host), port: portOf(rawPort) };
}

function portOf(raw: string | undefined): number {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PG_PORT;
}

// Split the authority's comma list. `host=` in the query is NOT consulted:
// that spelling is how a unix-socket directory is given, and this adapter
// refuses sockets anyway — nothing the control plane can reach is on one.
function parseHostList(authority: string): PgHost[] {
  const hosts: PgHost[] = [];
  for (const part of authority.split(",")) {
    const host = parseHost(part);
    if (host === null) return [];
    hosts.push(host);
  }
  return hosts;
}

function parseUri(value: string): ParsedPgConnString | null {
  if (!URI_SCHEME.test(value)) return null;
  let rest = value.replace(URI_SCHEME, "");
  // Query first, then path: a password must percent-encode `?` and `/`, so the
  // first of each delimits rather than appearing inside the authority.
  const params = new Map<string, string>();
  const queryAt = rest.indexOf("?");
  if (queryAt !== -1) {
    for (const [key, entry] of new URLSearchParams(rest.slice(queryAt + 1))) {
      params.set(key.toLowerCase(), entry);
    }
    rest = rest.slice(0, queryAt);
  }
  let database = "";
  const pathAt = rest.indexOf("/");
  if (pathAt !== -1) {
    database = decodeURIComponent(rest.slice(pathAt + 1));
    rest = rest.slice(0, pathAt);
  }
  let user = "";
  let password = "";
  // The LAST `@`: libpq requires a literal one in a password to be `%40`, so
  // this is exact for a well-formed string and still does the sane thing with
  // a lazily-quoted one.
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = userinfo.indexOf(":");
    user = decodeURIComponent(colon === -1 ? userinfo : userinfo.slice(0, colon));
    password = colon === -1 ? "" : decodeURIComponent(userinfo.slice(colon + 1));
  }
  const hosts = parseHostList(rest);
  // No host at all is the unix-socket spelling
  // (`postgresql:///db?host=/var/run/postgresql`). Refused rather than
  // half-supported: there is nothing for the network guard to vet and nothing
  // TLS could protect.
  if (hosts.length === 0) return null;
  return { form: "uri", hosts, database, user, password, params };
}

// libpq's keyword/value form: space-separated `key=value`, where a value
// containing a space or a quote is single-quoted with backslash escapes. Split
// by hand for the same reason the ADO reader is hand-written — the quoting
// exists precisely so a password may contain the delimiter.
function splitKeywordSegments(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(ch) && !quoted) {
      if (current.length > 0) segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

const KEYWORD_ALIASES: Record<string, string> = {
  host: "host",
  hostaddr: "host",
  port: "port",
  dbname: "database",
  user: "user",
  password: "password",
};

function parseKeyword(value: string): ParsedPgConnString | null {
  if (!/(^|\s)(host|hostaddr)\s*=/i.test(value)) return null;
  let hostField = "";
  let portField = "";
  let database = "";
  let user = "";
  let password = "";
  const params = new Map<string, string>();
  for (const segment of splitKeywordSegments(value)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const entry = segment.slice(eq + 1);
    switch (KEYWORD_ALIASES[key]) {
      case "host":
        hostField = entry;
        break;
      case "port":
        portField = entry;
        break;
      case "database":
        database = entry;
        break;
      case "user":
        user = entry;
        break;
      case "password":
        password = entry;
        break;
      default:
        params.set(key, entry);
    }
  }
  // `host=h1,h2 port=5432,5433` — libpq pairs the two lists positionally, and a
  // single port applies to every host. A host with no port of its own takes the
  // last one given, which is what libpq does with a short list.
  const ports = portField.split(",").map((raw) => portOf(raw.trim()));
  const hosts: PgHost[] = [];
  const names = hostField.split(",");
  for (const [index, name] of names.entries()) {
    const trimmed = name.trim();
    if (trimmed.length === 0) return null;
    // A directory rather than a host: the socket spelling, refused as above.
    if (trimmed.startsWith("/")) return null;
    hosts.push({ host: trimmed, port: ports[index] ?? ports[ports.length - 1] ?? DEFAULT_PG_PORT });
  }
  if (hosts.length === 0) return null;
  return { form: "keyword", hosts, database, user, password, params };
}

export function parsePgConnString(value: string): ParsedPgConnString | null {
  if (value.length === 0 || value.length > 4096) return null;
  return parseUri(value) ?? parseKeyword(value);
}

// Scheme guard, same contract as isMongoConnString and isMssqlConnString: only
// strings this adapter could actually dial, and never one another adapter claims,
// so engine detection stays unambiguous. The keyword form is the sharp edge here
// — it is anchored to a `host=`/`hostaddr=` key so that neither a mongo string
// carrying `host=` in a query parameter nor SQL Server's `Server=host;…` can
// claim it (the ADO reader anchors on `server`, which this never accepts).
export function isPgConnString(value: string): boolean {
  return parsePgConnString(value) !== null;
}

// Every host the string would dial, for the network guard. Never SRV: libpq
// resolves plain names and takes its HA list inline, so there is no second
// lookup that could widen the set after it has been vetted.
export function pgHosts(value: string): { hosts: string[]; isSrv: boolean } {
  const parsed = parsePgConnString(value);
  if (parsed === null) return { hosts: [], isSrv: false };
  return {
    hosts: parsed.hosts.map(({ host, port }) => `${host}:${port}`),
    isSrv: false,
  };
}

// What the string asks of the transport. Absent defaults to `prefer`, which is
// libpq's own default and the reason this adapter cannot simply trust a pasted
// string: `prefer` will fall back to plaintext without saying so.
// What the string asks of the transport, as the DRIVER will read it. Absent is
// reported as `disable` and not as libpq's `prefer`, because that is what node-pg
// actually does: with no sslmode at all it connects in plaintext against a server
// offering TLS (measured — `pg_stat_ssl.ssl` false, and no warning). libpq would
// have tried TLS first. Treating absence as `prefer` would rank a plaintext
// string one rung above the floor it actually sits on.
export function sslModeOf(parsed: ParsedPgConnString): PgSslMode {
  return explicitSslMode(parsed) ?? "disable";
}

// `uselibpqcompat=true` — the driver's own opt-in to libpq semantics, and the
// only way to reach the "encrypted, certificate not validated" rung at all.
export function usesLibpqCompat(parsed: ParsedPgConnString): boolean {
  return (parsed.params.get("uselibpqcompat") ?? "").toLowerCase() === "true";
}

// How much trust a string actually gives away, on THIS driver. Higher is
// stronger. Measured on pg 8.22.0 against a server with a self-signed
// certificate, because the driver's reading of sslmode is not libpq's:
//
//   sslmode=require            REFUSED  — silently aliased to verify-full
//   sslmode=verify-ca          REFUSED  — likewise
//   sslmode=verify-full        REFUSED  — correct
//   uselibpqcompat + require   CONNECTED, encrypted, certificate unchecked
//   uselibpqcompat + verify-ca REFUSED  — demands an explicit CA file
//   sslmode=disable            CONNECTED in plaintext
//   (no sslmode)              CONNECTED in plaintext
//
// The driver warns about the aliasing itself and says it will adopt libpq
// semantics in pg 9. Writing `uselibpqcompat=true` alongside every relaxation is
// what makes the stored string mean the same thing before and after that change,
// rather than silently loosening on a dependency bump.
export function effectivePgTrust(parsed: ParsedPgConnString): number {
  const mode = sslModeOf(parsed);
  if (mode === "disable") return MODE_RANK.disable;
  if (!usesLibpqCompat(parsed)) {
    // Every non-disable mode is verify-full here, including `prefer`, which
    // refuses a server with no TLS at all rather than falling back.
    return MODE_RANK["verify-full"];
  }
  return MODE_RANK[mode];
}

// The mode the string actually NAMES, or null when it names none — which is a
// different thing from `sslModeOf`'s answer, and the distinction is load-bearing
// for applyPgTlsOverrides. `prefer` inferred from an absent option is not a
// decision to be stronger than the boxes; it is the absence of a decision, and
// treating the two alike had apply writing `sslmode=prefer` over a ticked
// "connect without TLS" — a mode nobody chose, weaker than the strict default
// and not the one that was consented to either.
function explicitSslMode(parsed: ParsedPgConnString): PgSslMode | null {
  const raw = parsed.params.get("sslmode")?.toLowerCase();
  return SSL_MODES.find((mode) => mode === raw) ?? null;
}

export function pgConnStringUsername(value: string): string | null {
  const parsed = parsePgConnString(value);
  if (parsed === null || parsed.user.length === 0) return null;
  return parsed.user;
}

// TlsOverrides → sslmode, and the mapping is exact here in a way neither other
// engine's is: libpq's ladder happens to have one rung per concession this
// product already asks an owner to tick.
//
//   (nothing ticked)          → verify-full   chain AND hostname validated
//   allowInvalidHostnames     → verify-ca     chain validated, hostname not
//   allowInvalidCertificates  → require       encrypted, nothing validated
//   insecure                  → disable       plaintext
//
// `require` is the rung worth naming out loud, because its name is a lie by
// modern standards: it means "I insist on TLS" and not "I insist on a peer I can
// trust", so a string pasted with sslmode=require has already conceded the
// certificate — which is exactly why the strict default below is verify-full and
// not require, and why the assert refuses a pasted `require` unless the box for
// it is ticked.
export const modeForOverrides = (overrides: TlsOverrides): PgSslMode => {
  if (overrides.insecure) return "disable";
  if (overrides.allowInvalidCertificates) return "require";
  // allowInvalidHostnames alone has NO usable rung on this driver:
  // `uselibpqcompat=true&sslmode=verify-ca` refuses outright without an explicit
  // CA file, and a pasted connection string is not a place to put a PEM. So the
  // box on its own does not relax anything, and assertPgTlsEnforced refuses it
  // with the wider box named instead of quietly granting the wider concession —
  // the same call, for the same reason, as mssql/conn-string.ts.
  return "verify-full";
};

// How much trust each mode gives away, for comparing a pasted string against
// what the owner consented to. Higher is stronger.
export const MODE_RANK: Readonly<Record<PgSslMode, number>> = {
  disable: 0,
  allow: 1,
  prefer: 1,
  require: 2,
  "verify-ca": 3,
  "verify-full": 4,
};

// The owner's checkbox choices written into the string, so what is stored and
// what was consented to cannot disagree. Always authoritative for sslmode: it is
// a single option with a total order, so unlike mongo's several independent
// flags there is nothing to preserve alongside the answer.
export function applyPgTlsOverrides(value: string, overrides: TlsOverrides): string {
  const parsed = parsePgConnString(value);
  if (parsed === null) return value;
  const wanted = modeForOverrides(overrides);
  // A string that NAMES a mode stronger than the boxes allow is left as it is —
  // the same rule the assert applies, so the two cannot disagree about one
  // string. One that names nothing gets exactly what the boxes mean.
  const found = explicitSslMode(parsed);
  const mode = found !== null && MODE_RANK[found] > MODE_RANK[wanted] ? found : wanted;
  // `require` only means "encrypted, certificate unchecked" under the compat
  // flag; without it the driver silently upgrades it to verify-full and the
  // ticked box does nothing. Written for that rung and REMOVED otherwise, so a
  // string that no longer concedes anything does not keep carrying the opt-in
  // that would loosen it again on the next driver major.
  const withMode = withPgParam(value, "sslmode", mode);
  return withPgParam(withMode, "uselibpqcompat", mode === "require" ? "true" : null);
}

// Rewrite one option in the string, preserving its form and removing any casing
// variants so the stored string cannot carry a second, contradicting copy.
function withPgParam(value: string, key: string, replacement: string | null): string {
  const parsed = parsePgConnString(value);
  if (parsed === null) return value;
  if (parsed.form === "uri") {
    const queryAt = value.indexOf("?");
    const head = queryAt === -1 ? value : value.slice(0, queryAt);
    const search = new URLSearchParams(queryAt === -1 ? "" : value.slice(queryAt + 1));
    for (const existing of [...search.keys()]) {
      if (existing.toLowerCase() === key) search.delete(existing);
    }
    if (replacement !== null) search.set(key, replacement);
    const query = search.toString();
    return query.length === 0 ? head : `${head}?${query}`;
  }
  const kept = splitKeywordSegments(value).filter((segment) => {
    const eq = segment.indexOf("=");
    if (eq === -1) return true;
    return segment.slice(0, eq).trim().toLowerCase() !== key;
  });
  if (replacement !== null) kept.push(`${key}=${replacement}`);
  return kept.map(quoteKeywordSegment).join(" ");
}

// Re-quote a segment that needs it. Round-tripping the keyword form means
// putting back the quoting the split above removed, or a password with a space
// in it survives parsing and not re-serialization.
function quoteKeywordSegment(segment: string): string {
  const eq = segment.indexOf("=");
  if (eq === -1) return segment;
  const key = segment.slice(0, eq);
  const entry = segment.slice(eq + 1);
  if (!/[\s'\\]/.test(entry)) return `${key}=${entry}`;
  return `${key}='${entry.replace(/([\\'])/g, "\\$1")}'`;
}

// The same credentials and the same options, pointed at one host (#202). A
// standby keeps its OWN idx_scan counters, so collecting from one means dialling
// it directly with what the owner already gave us — and a multi-host HA string
// must be narrowed to the single node being read, or libpq picks for us.
export function retargetPgConnString(value: string, host: string, port: number): string {
  const parsed = parsePgConnString(value);
  if (parsed === null) return value;
  if (parsed.form === "uri") {
    const withHost = replaceUriAuthority(value, `${bracketIfNeeded(host)}:${port}`);
    return withHost ?? value;
  }
  const kept = splitKeywordSegments(value).filter((segment) => {
    const eq = segment.indexOf("=");
    if (eq === -1) return true;
    const canonical = KEYWORD_ALIASES[segment.slice(0, eq).trim().toLowerCase()];
    return canonical !== "host" && canonical !== "port";
  });
  return [`host=${host}`, `port=${port}`, ...kept].map(quoteKeywordSegment).join(" ");
}

// The same server and the same options, as somebody else (#203). What the scoped
// role gets handed after provisioning: the owner's admin string with its
// credentials replaced, so every choice they made about transport survives into
// the string we store — and the admin one is never persisted at all.
export function withPgCredentials(value: string, user: string, password: string): string {
  const parsed = parsePgConnString(value);
  if (parsed === null) return value;
  if (parsed.form === "uri") {
    const authority = parsed.hosts
      .map(({ host, port }) => `${bracketIfNeeded(host)}:${port}`)
      .join(",");
    const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
    return replaceUriAuthority(value, authority, credentials) ?? value;
  }
  const kept = splitKeywordSegments(value).filter((segment) => {
    const eq = segment.indexOf("=");
    if (eq === -1) return true;
    const canonical = KEYWORD_ALIASES[segment.slice(0, eq).trim().toLowerCase()];
    return canonical !== "user" && canonical !== "password";
  });
  return [...kept, `user=${user}`, `password=${password}`].map(quoteKeywordSegment).join(" ");
}

// An IPv6 literal needs its brackets back before a port can be appended to it.
function bracketIfNeeded(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

// Swap the authority (and optionally the userinfo) of a URI string, keeping the
// scheme it was pasted with, its database and every query parameter. Hand-built
// for the same reason parseUri is: a URL object cannot hold the multi-host form.
function replaceUriAuthority(
  value: string,
  authority: string,
  credentials?: string,
): string | null {
  const scheme = URI_SCHEME.exec(value)?.[0];
  if (scheme === undefined) return null;
  let rest = value.slice(scheme.length);
  let tail = "";
  const queryAt = rest.indexOf("?");
  if (queryAt !== -1) {
    tail = rest.slice(queryAt);
    rest = rest.slice(0, queryAt);
  }
  const pathAt = rest.indexOf("/");
  if (pathAt !== -1) {
    tail = rest.slice(pathAt) + tail;
    rest = rest.slice(0, pathAt);
  }
  const at = rest.lastIndexOf("@");
  const userinfo = credentials ?? (at === -1 ? "" : rest.slice(0, at));
  const prefix = userinfo.length === 0 ? "" : `${userinfo}@`;
  return `${scheme}${prefix}${authority}${tail}`;
}

// The same server and credentials, pointed at another database. Postgres has no
// cross-database reference at all — `SELECT … FROM other.public.t` is a parse
// error, not a permission one (verified on 17.11) — so unlike SQL Server's one
// pool serving every database through three-part names, each database needs its
// own dial. This is what the collector retargets with.
export function withPgDatabase(value: string, database: string): string {
  const parsed = parsePgConnString(value);
  if (parsed === null) return value;
  if (parsed.form === "uri") {
    const scheme = URI_SCHEME.exec(value)?.[0] ?? "";
    let rest = value.slice(scheme.length);
    let query = "";
    const queryAt = rest.indexOf("?");
    if (queryAt !== -1) {
      query = rest.slice(queryAt);
      rest = rest.slice(0, queryAt);
    }
    const pathAt = rest.indexOf("/");
    const authority = pathAt === -1 ? rest : rest.slice(0, pathAt);
    return `${scheme}${authority}/${encodeURIComponent(database)}${query}`;
  }
  const kept = splitKeywordSegments(value).filter((segment) => {
    const eq = segment.indexOf("=");
    if (eq === -1) return true;
    return KEYWORD_ALIASES[segment.slice(0, eq).trim().toLowerCase()] !== "database";
  });
  return [...kept, `dbname=${database}`].map(quoteKeywordSegment).join(" ");
}
