import { z } from "zod";
import { PLANS } from "../billing/plans";

// What the environment must be, per process, as a schema rather than as
// twenty-eight readers that each decide for themselves what a bad value means.
//
// ONE RULE, applied everywhere below: **absent is fine, malformed is fatal.**
// That is what the old readers were reaching for and could not express.
// `positiveEnv("AUTH_RATE_LIMIT_MAX", 20)` read `2O` (letter O) as 20, so a
// fat-fingered brute-force budget looked correct; `trustProxySetting()` read a
// garbled CIDR list as "no proxy", so a typo silently collapsed every per-client
// rate limit into one shared bucket. Both are now boot failures that name the
// variable. An unset optional knob still falls back to its default, which is the
// half of that behaviour worth keeping.
//
// Pure: everything here parses a record it is given. Nothing reads process.env —
// see ./env.ts for the one place that does.

// Empty is absent. Compose passes `SMTP_HOST: ${SMTP_HOST}` through as "" when
// the .env file has no value, and Helm renders an unset value the same way, so a
// schema that told those apart from unset would refuse to boot on the stacks
// this repo ships. Whitespace-only goes with it — nothing here wants " " and
// TRUST_PROXY already treated it as off.
export function withoutBlanks(raw: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

// An optional numeric knob. Unset takes the default; anything that is not a
// positive number refuses to boot rather than reading as the default.
function positive(fallback: number): z.ZodType<number, string | undefined> {
  return z
    .string()
    .default(String(fallback))
    .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
      message: "expected a positive number",
    })
    .transform(Number);
}

// The same, without a default: unset means "the caller decides", which is not
// the same as zero (RETENTION_DAYS unset is no ceiling, not no history).
function optionalPositive(): z.ZodType<number | undefined, string | undefined> {
  return z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || (Number.isFinite(Number(value)) && Number(value) > 0),
      {
        message: "expected a positive number",
      },
    )
    .transform((value) => (value === undefined ? undefined : Number(value)));
}

function positiveInteger(fallback: number): z.ZodType<number, string | undefined> {
  return z
    .string()
    .default(String(fallback))
    .refine((value) => Number.isInteger(Number(value)) && Number(value) > 0, {
      message: "expected a positive whole number",
    })
    .transform(Number);
}

// Exactly "true" or "false". Not truthiness: `REQUIRE_OWNER_2FA=1` reading as
// OFF is precisely the kind of silence this file exists to remove, and every
// producer in the repo (the chart quotes its booleans, compose quotes its
// strings) already writes one of the two words.
function flag(fallback: boolean): z.ZodType<boolean, string | undefined> {
  return z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");
}

// 32 bytes of base64, checked here rather than at the first cluster connect.
// Buffer.from(x, "base64") never throws — it drops what it cannot read — so a
// truncated MASTER_KEY used to produce a short key that xchacha20poly1305
// rejected hours later, inside a job, with a message about a nonce.
export function decodeKey(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function masterKey(): z.ZodType<string, string> {
  return z.string().refine((value) => decodeKey(value).length === 32, {
    message: "expected 32 bytes of base64 — generate one with `openssl rand -base64 32`",
  });
}

// The CIDR entries of a TRUST_PROXY value.
//
// better-auth needs to know WHICH hops to distrust rather than only that a proxy
// exists: without a list it trusts a forwarded header only when it carries
// exactly one address, and behind an ingress the header usually carries two or
// more (client, ingress). Every hop then goes unresolved, which is not a broken
// limit but a shared one — every client lands in the same bucket (#54).
//
// Pure over its argument, and the schema below uses it to decide whether the
// value is well-formed at all.
export function cidrEntries(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(entry) && /[.:]/.test(entry));
}

// Fastify's trustProxy: "true", a hop count ("1" — trust the last N proxies), or
// a CIDR list ("10.0.0.0/8,192.168.0.0/16").
//
// Off by default and opt-in on purpose: trusting X-Forwarded-For while directly
// exposed is worse than not resolving the address at all, because then any
// client can forge a fresh IP per request and never hit a limit.
export type TrustProxy = boolean | number | string;

export function trustProxyFrom(raw: string): TrustProxy {
  const value = raw.trim();
  if (value === "false") return false;
  if (value === "true") return true;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0) return hops;
  return value;
}

// Well-formed means one of the three dialects above — and for the list dialect,
// that EVERY entry is address-shaped. The old reader kept the address-shaped
// entries of a mixed list and threw the rest away, so `TRUST_PROXY=ture` and a
// list with one bad range both read as "no proxy in front" and the deployment
// served on with one shared rate-limit bucket.
function isTrustProxyValue(raw: string): boolean {
  const value = raw.trim();
  if (value === "true" || value === "false") return true;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0) return true;
  const entries = value.split(",").map((entry) => entry.trim());
  return entries.length > 0 && entries.every((entry) => cidrEntries(entry).length === 1);
}

function trustProxy(): z.ZodType<TrustProxy, string | undefined> {
  return z
    .string()
    .default("false")
    .refine(isTrustProxyValue, {
      message:
        'expected "true", "false", a hop count ("1"), or a comma-separated CIDR list ("10.0.0.0/8,192.168.0.0/16")',
    })
    .transform(trustProxyFrom);
}

// Every process reads these. `migrate` is the floor rather than a convenience:
// the Helm pre-install hook gives that Job DATABASE_URL and nothing else, so a
// schema that demanded MASTER_KEY of it would fail every install.
const migrateShape = {
  // Not an enum. Only "production" is ever compared against, and a deployment
  // that says "staging" is doing something reasonable that a closed enum would
  // refuse to boot.
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: "expected a postgres:// or postgresql:// connection string",
  }),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Read by @repo/errors, which every workload initialises before Nest exists.
  // Validated here so a malformed DSN is a boot failure rather than an SDK that
  // quietly reports nowhere.
  SENTRY_DSN: z.url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
};

// The worker: the jobs, the analysis engine, mail, and the credentials it has to
// unseal to reach a customer's cluster.
//
// MASTER_KEY is required HERE and not one layer down, which answers the open
// question in #126: a worker booted without it starts fine today and fails at
// the first job that opens a cluster — inside jobs/cluster-connection.ts, as a
// decrypt error, hours after the deploy that caused it.
const workerShape = {
  ...migrateShape,
  MASTER_KEY: masterKey(),
  // KEK rotation: v1 = MASTER_KEY, v2+ = MASTER_KEY_V<n>. Each cluster row
  // records the version that sealed it, so old rows stay readable through a
  // rotation. Cross-checked below — a version with no key behind it is the
  // rotation's one unrecoverable mistake.
  MASTER_KEY_VERSION: positiveInteger(1),
  DEFAULT_ORG_PLAN: z.enum(PLANS).default("FREE"),
  // The operator's retention ceiling. Unset means no ceiling — the plan decides
  // — which is why this one has no default.
  RETENTION_DAYS: optionalPositive(),
  STORAGE_USD_PER_GB_MONTH: optionalPositive(),
  ALLOW_PRIVATE_CLUSTER_TARGETS: flag(false),
  ALLOW_INSECURE_CLUSTER_TLS: flag(false),
  ALLOW_UNTESTED_MONGO_VERSION: flag(false),
  WORKER_CONCURRENCY: positiveInteger(2),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: positive(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.email().optional(),
  METRICS_ENABLED: flag(false),
  METRICS_PORT: positive(9464),
};

// The api, which additionally serves HTTP and auth.
const apiShape = {
  ...workerShape,
  API_PORT: positive(3001),
  BETTER_AUTH_SECRET: z.string().min(1),
  // The DASHBOARD's public origin, not the api's port: the api serves
  // better-auth under /api/auth on that same origin, and better-auth appends
  // /api/auth itself.
  BETTER_AUTH_URL: z.url().default("http://localhost:3001"),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  ALLOW_INSECURE_AUTH_URL: flag(false),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  REQUIRE_EMAIL_VERIFICATION: flag(false),
  REQUIRE_OWNER_2FA: flag(false),
  SIGNUP_MODE: z.enum(["invite", "open", "closed"]).default("invite"),
  TRUST_PROXY: trustProxy(),
  RATE_LIMIT_MAX: positive(300),
  AUTH_RATE_LIMIT_MAX: positive(20),
  RUN_WORKER: flag(false),
};

// Which variables hold a secret, so the error report can name the variable
// without printing what was in it.
export const SECRET_VARS = new Set([
  "DATABASE_URL",
  "MASTER_KEY",
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_SECRET",
  "SMTP_PASS",
  "SENTRY_DSN",
]);

// A rotation whose MASTER_KEY_VERSION names a key that is not in the
// environment. Every cluster row sealed at the new version becomes unreadable —
// the one mistake in this file with no recovery — and today it is discovered by
// a job failing to decrypt. `looseObject` is what makes the dynamically-named
// keys visible to this check at all.
function checkRotationKeys(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const version = value.MASTER_KEY_VERSION;
  if (typeof version !== "number") return;
  for (let n = 2; n <= version; n++) {
    const name = `MASTER_KEY_V${n}`;
    const raw = value[name];
    if (typeof raw !== "string") {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `required: MASTER_KEY_VERSION is ${version}, so rows are sealed with this key`,
      });
      continue;
    }
    if (decodeKey(raw).length !== 32) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: "expected 32 bytes of base64 — generate one with `openssl rand -base64 32`",
      });
    }
  }
}

// Half-configured SMTP. mail/mailer.ts builds no transport unless it has all
// three, so a deployment with a host and no credentials sends nothing — while
// the invitations, the password resets and the emailed two-factor code all
// report success. Naming the missing half at boot is the whole point of this
// file; sending is still entirely optional, and leaving SMTP_HOST unset is how
// a deployment says so.
function checkMailGroup(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (typeof value.SMTP_HOST !== "string") return;
  for (const name of ["SMTP_USER", "SMTP_PASS"]) {
    if (typeof value[name] === "string") continue;
    ctx.addIssue({
      code: "custom",
      path: [name],
      message: "required: SMTP_HOST is set, and mail is not sent without credentials",
    });
  }
}

// Loose, not strict: the environment of any real process carries PATH, HOME and
// whatever the platform injects, and a schema that refused unknown keys would
// refuse to boot anywhere. Drift in the OTHER direction — a variable the chart
// sets that no schema knows — is caught by config/homes.test.ts, which is the
// place that can tell a typo from the operating system.
export const migrateEnvSchema = z.looseObject(migrateShape);
export const workerEnvSchema = z
  .looseObject(workerShape)
  .superRefine(checkRotationKeys)
  .superRefine(checkMailGroup);
export const apiEnvSchema = z
  .looseObject(apiShape)
  .superRefine(checkRotationKeys)
  .superRefine(checkMailGroup);

export const PROCESS_SCHEMAS = {
  api: apiEnvSchema,
  worker: workerEnvSchema,
  migrate: migrateEnvSchema,
} as const;

export type ProcessName = keyof typeof PROCESS_SCHEMAS;

export type MigrateEnv = z.infer<typeof migrateEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;

// The names each process's schema declares, for the tests that hold the four
// homes a variable has to be registered in to the schema.
export function declaredVars(process: ProcessName): string[] {
  const shape = { api: apiShape, worker: workerShape, migrate: migrateShape }[process];
  return Object.keys(shape);
}

// Which of them a process refuses to start without.
export function requiredVars(process: ProcessName): string[] {
  const schema = PROCESS_SCHEMAS[process];
  const result = schema.safeParse({});
  if (result.success) return [];
  return [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
}
