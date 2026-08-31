// What is removed from an event before it leaves the building, and the only
// part of error reporting that is worth unit-testing: pure over its input, so
// the rule can be proved without a DSN, a network or an SDK.
//
// The threat is specific. This service holds a connection string for every
// customer cluster, and the MongoDB driver puts it in the MESSAGE of the errors
// it throws — `MongoServerSelectionError` names the hosts it could not reach,
// and an auth failure can carry the whole URI. Redacting request headers is
// therefore not enough on its own: the string arrives inside `exception.value`,
// where no header rule looks.

export const REDACTED = "[redacted]";

// A database URI in full, not only its credentials. The host list of a replica
// set names the customer's infrastructure, and a `+srv` record resolves to it —
// so the hostname is as much theirs to keep as the password is.
const DATABASE_URI = /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?):\/\/[^\s"'`<>]+/gi;

// Credentials in a URI of any other scheme (SMTP, an http webhook). The scheme
// is kept so the message still says what kind of thing failed; the userinfo is
// what must never leave.
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

// Keys whose VALUE is a secret whatever it happens to look like — a base64 key
// matches no URI pattern. The first three are the Fastify logger's redact list
// (apps/api/src/main.ts), which #31 names as the floor this has to match; the
// rest are the env names and payload fields that would otherwise ride along in
// a context or an extra.
//
// Normalised on the way in, so `set-cookie`, `setCookie` and `SET_COOKIE` are
// one entry rather than three that someone has to remember to keep in step.
const SECRET_KEYS = new Set(
  [
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "connection_string",
    "connectionuri",
    "uri",
    "dsn",
    "database_url",
    "mongo_url",
    "master_key",
    "better_auth_secret",
    "smtp_url",
    "smtp_pass",
    "smtp_password",
    "github_client_secret",
    "sentry_auth_token",
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "accesstoken",
    "refreshtoken",
    "sessiontoken",
    "backupcodes",
    "totpsecret",
  ].map(normaliseKey),
);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(normaliseKey(key));
}

// A secret inside a JSON-ENCODED string, which key matching cannot reach because
// the whole object arrived as one value. Found by measurement: a live 500 on the
// sign-in route delivered `request.data` as the string
// `{"email":"…","password":"…"}`, where `password` is not a key of anything —
// it is six characters in the middle of a scalar. Bodies are dropped outright by
// scrubEvent below, so this is the second line rather than the first; it is here
// because a body is not the only thing that gets stringified on its way into a
// log line — a console breadcrumb is the other.
const JSON_SECRET = new RegExp(
  `("(?:${[
    "password",
    "passwd",
    "secret",
    "token",
    "accessToken",
    "refreshToken",
    "apiKey",
    "connectionString",
    "sealed_dek",
    "sealed_data",
  ].join("|")})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
  "gi",
);

export function scrubString(value: string): string {
  return value
    .replace(DATABASE_URI, REDACTED)
    .replace(URI_CREDENTIALS, `$1${REDACTED}@`)
    .replace(JSON_SECRET, `$1"${REDACTED}"`);
}

// Deep rather than field-by-field, and that is the decision here. A list of
// fields to scrub — message, exception.value, request.data — is a list that is
// correct until the SDK adds the next field, and the way it would be wrong is
// silent: a connection string in a context nobody enumerated, shipped for
// months. Walking everything costs a pass over an object that is already about
// to be JSON-serialised.
const MAX_DEPTH = 12;

// Declared over the walk rather than asserted onto its result.
//
// `scrubValue` takes an arbitrary value and rebuilds it, so what comes back has
// the same STRUCTURE as what went in — every branch either returns the value
// untouched or replaces a string with a string. TypeScript cannot derive that: a
// recursive `unknown -> unknown` walk has nowhere to carry T, and narrowing
// `value` to `T & string` does not make `scrubString`'s `string` assignable back.
//
// So the correspondence is stated as an overload signature. The body below is
// checked as `unknown -> unknown` and claims nothing — there is no cast in it,
// and no caller has to make one either, which is where returning `unknown` would
// have put them. What holds it honest is the suite: the round-trip tests assert
// the shape survives, not just that the secrets are gone.
export function scrub<T>(value: T): T;
export function scrub(value: unknown): unknown {
  return scrubValue(value, 0, new WeakSet());
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object" || value === null) return value;
  // A cycle and an over-deep branch are both returned untouched rather than
  // dropped: this runs on the way to the wire, and losing the event is a worse
  // outcome than the one string this cannot reach.
  if (depth >= MAX_DEPTH || seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : scrubValue(item, depth + 1, seen);
  }
  return out;
}

// What `beforeSend` uses: the deep scrub, plus the request body dropped whole.
//
// The body is dropped rather than scrubbed because of what this product puts in
// one. `POST /clusters` carries a customer's connection string as a field, and
// there is no version of "mostly redacted" that is good enough for that. It is
// also the control that actually holds: `dataCollection.httpBodies: []` is set
// in the provider and the body arrived at a collector anyway — measured against
// a live 500 on the sign-in route, twice, so this is not a guess about SDK
// behaviour.
//
// Breadcrumbs keep using `scrub` alone: a console line is worth reading, and it
// has no equivalent single field to remove.
export function scrubEvent<T>(event: T): T {
  const scrubbed = scrub(event);
  if (typeof scrubbed !== "object" || scrubbed === null) return scrubbed;
  const request: unknown = Reflect.get(scrubbed, "request");
  if (typeof request === "object" && request !== null && "data" in request) {
    Reflect.set(request, "data", REDACTED);
  }
  return scrubbed;
}
