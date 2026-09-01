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

/**
 * The public entry, and the shape it returns is CHECKED rather than claimed.
 *
 * Two earlier versions of this line were the same claim in different clothes.
 * `scrubValue(...) as T` asserted the whole result. Replacing it with an
 * overload — `scrub<T>(value: T): T` declared over an `unknown -> unknown` body
 * — only moved the claim into a signature TypeScript does not check against its
 * implementation: an overload promising `T[]` over a body returning a scalar
 * compiles just as happily.
 *
 * What is checked here: `{ ...value }` of a `T` IS a `T`, so the copy carries
 * every key the input had and comes back as the type it went in as. Nothing is
 * rebuilt from an empty object, so a field cannot silently go missing.
 *
 * What is NOT, and it is one line rather than the whole result: `Reflect.set`
 * writes a scrubbed value back without checking it against that field's declared
 * type. That is the operation itself — a `password: string` becomes
 * "[redacted]", and a field typed as a string LITERAL genuinely does not survive
 * — so it is the part that could not be true, stated where it happens instead of
 * covering for the rest.
 *
 * `T extends object` because all three callers are Sentry hooks and an event, a
 * transaction and a breadcrumb are objects. A top-level array is refused rather
 * than quietly returned keyed by index; nested ones are walked below.
 */
export function scrub<T extends object>(value: T): T {
  if (Array.isArray(value)) {
    throw new TypeError("scrub takes an event-shaped object, not an array");
  }
  const seen = new WeakSet<object>([value]);
  const copy = { ...value };
  for (const [key, item] of Object.entries(copy)) {
    Reflect.set(copy, key, isSecretKey(key) ? REDACTED : scrubValue(item, 1, seen));
  }
  return copy;
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
export function scrubEvent<T extends object>(event: T): T {
  const scrubbed = scrub(event);
  const request: unknown = Reflect.get(scrubbed, "request");
  if (typeof request === "object" && request !== null && "data" in request) {
    Reflect.set(request, "data", REDACTED);
  }
  return scrubbed;
}
