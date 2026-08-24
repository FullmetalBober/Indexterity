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

// The pipeline: the jobs, the analysis engine, mail, and the credentials it has
// to unseal to reach a customer's cluster. The standalone worker process that
// once validated exactly this set is gone (#232); the shape survives as the
// api's job-running half, and as the whole of what the rotate-key CLI — the one
// remaining process that unseals credentials without serving HTTP — validates.
//
// MASTER_KEY is required HERE and not one layer down, which answers the open
// question in #126: a process booted without it starts fine and fails at the
// first job that opens a cluster — inside jobs/cluster-connection.ts, as a
// decrypt error, hours after the deploy that caused it.
const workerShape = {
  ...migrateShape,
  // Postgres connections PER POOL, and this process holds more than one: the api
  // has a request pool (shared with the jobs since #231 — the tick's drains run
  // against it) and better-auth's, each capped by this. They are deliberately
  // not merged — a slow report must not be able to starve sign-in of a
  // connection — so the budget to size against postgres is this times the
  // number of pools.
  //
  // Too low is latency, not failure: pg queues a request until a connection frees.
  // Raise it alongside WORKER_CONCURRENCY, which is what makes a drain ask for
  // more than one at a time (the drain is capped below this either way, so it
  // can never take the whole request pool).
  PG_POOL_MAX: positiveInteger(5),
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
  // One flag for every engine rather than one per engine. The knob answers a
  // single question — "may a cluster on a major series this release has not been
  // probed against connect at all?" — and an operator running two engines had to
  // find and set two variables to say one thing. The floor is never overridable
  // on any engine; this is only ever the ceiling.
  ALLOW_UNTESTED_DATABASE_VERSION: flag(false),
  // One job at a time. Each concurrent job holds its own working set — a collect
  // pass keeps a cluster's index and collection statistics in memory while it
  // runs — so this multiplies the process's memory rather than sharing it, and
  // the pipeline is not latency-critical. Raise it deliberately, with the memory
  // limit raised alongside. The name survives the worker process it was named
  // for (#232): it is how many jobs one drain runs at once.
  WORKER_CONCURRENCY: positiveInteger(1),
  // Sockets the driver may open against ONE connected cluster. The driver's own
  // default is 100, and it is the wrong default twice over here: a session is
  // held per cluster (jobs/connection-pool.ts), so the worst case multiplies by
  // the fleet, and the sockets are opened against a database that is not ours.
  //
  // Ten is generous for what the collectors actually ask for. Their fan-outs are
  // per replica-set MEMBER and each member has its own client; the widest
  // concurrent use of a single connection is the five reads in mongo/snapshots.ts.
  MONGO_MAX_POOL_SIZE: positiveInteger(10),
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
  // Whether THIS process owns the recurring schedule. The one topology question
  // left (#232 removed RUN_WORKER along with the process it selected): every
  // api executes jobs, and this decides WHEN they become due.
  //
  // True means a 30-second in-process interval runs the tick
  // (jobs/tick.service.ts) — no crontab, no resident runner since #231. False
  // opens GET /api/internal/tick instead, where something external says "now":
  // that request claims AND drains, bounded so it answers inside platform proxy
  // timeouts, and a drained:false response means ping again — the occurrence
  // claims make repeats free.
  RUN_CRONJOB: flag(true),
  // The bearer token that endpoint demands. Required when RUN_CRONJOB is false
  // and refused as too short otherwise: it authorises the whole pipeline, there
  // is no user session behind it to fall back on, and the endpoint is on the
  // same public origin as everything else. 32 characters is the floor because
  // the global per-IP budget (RATE_LIMIT_MAX, 300/min) is the only other thing
  // slowing a guess down.
  CRON_TRIGGER_SECRET: z.string().optional(),
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

// Every rotation key is a KEK, and they are the one group of secrets here whose
// NAMES are dynamic — so a literal set could never hold them, and it did not: a
// malformed MASTER_KEY_V2 was reported as `expected 32 bytes of base64 (got
// "…")`, printing the key material into the boot log of the process that
// refused to start. The set below is the answer to "is this variable's value
// safe to quote", so it has to be asked as a question and not as a lookup.
export function isSecretVar(name: string): boolean {
  return SECRET_VARS.has(name) || /^MASTER_KEY_V\d+$/.test(name);
}

// A rotation whose MASTER_KEY_VERSION names a key that is not in the
// environment. Every cluster row sealed at the new version becomes unreadable —
// the one mistake in this file with no recovery — and today it is discovered by
// a job failing to decrypt. `looseObject` is what makes the dynamically-named
// keys visible to this check at all.
function checkRotationKeys(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const version = value.MASTER_KEY_VERSION;
  if (typeof version !== "number") return;
  // v1 is the one version that need not be named — MASTER_KEY is its fallback —
  // so it is checked only when it IS named. Unchecked, a retired key supplied as
  // 32 characters instead of 32 bytes would boot fine and fail later, per row,
  // as a decrypt error: the shape of failure this whole function exists to move
  // forward to boot.
  const v1 = value.MASTER_KEY_V1;
  if (typeof v1 === "string" && decodeKey(v1).length !== 32) {
    ctx.addIssue({
      code: "custom",
      path: ["MASTER_KEY_V1"],
      message: "expected 32 bytes of base64 — generate one with `openssl rand -base64 32`",
    });
  }
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
// Requiring a verified address on a deployment that cannot send mail is a state
// with no way out: sign-up succeeds, the mail is a logged no-op, and sign-in is
// refused forever with no address able to verify itself. Every account created on
// such an install is unreachable, including the first owner's — which is exactly
// how the hosted deployment locked its own owner out (#306).
//
// Refused at boot rather than handled downstream, for the same reason
// checkMailGroup is: the operator can fix it in one line, and no page can.
function checkVerificationNeedsMail(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (value.REQUIRE_EMAIL_VERIFICATION !== true) return;
  if (typeof value.SMTP_HOST === "string") return;
  // Reported against REQUIRE_EMAIL_VERIFICATION rather than the absent
  // SMTP_HOST, and that is not cosmetic: config/env.ts prints a bare "required"
  // for any path with no value and drops the refinement's message with it, so
  // aimed at SMTP_HOST this explanation would never reach the operator. Aimed at
  // the flag — which is present, and is the setting to reconsider — the sentence
  // survives and names both halves.
  ctx.addIssue({
    code: "custom",
    path: ["REQUIRE_EMAIL_VERIFICATION"],
    message:
      "cannot be on without mail: an address cannot verify itself, so every " +
      "account created here would be locked out. Configure SMTP_HOST, SMTP_USER " +
      "and SMTP_PASS, or turn REQUIRE_EMAIL_VERIFICATION off",
  });
}

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
// The endpoint that runs the pipeline, with nothing in front of it.
//
// Booting without the secret would leave RUN_CRONJOB=false in the one state
// where nothing can ever tick: the crontab is not installed and the only way to
// trigger it refuses every caller. That is a silently dead pipeline, which is
// the failure this whole file exists to move forward to boot.
function checkCronTrigger(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (value.RUN_CRONJOB !== false) return;
  const secret = value.CRON_TRIGGER_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["CRON_TRIGGER_SECRET"],
      message:
        "required: RUN_CRONJOB=false installs no schedule, so GET /api/internal/tick is the " +
        "only thing that can start a pass — generate one with `openssl rand -hex 32`",
    });
    return;
  }
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    ctx.addIssue({
      code: "custom",
      path: ["CRON_TRIGGER_SECRET"],
      message: `expected at least ${MIN_CRON_SECRET_LENGTH} characters — this token authorises the whole pipeline`,
    });
  }
}

export const MIN_CRON_SECRET_LENGTH = 32;

export const migrateEnvSchema = z.looseObject(migrateShape);
export const workerEnvSchema = z
  .looseObject(workerShape)
  .superRefine(checkRotationKeys)
  .superRefine(checkMailGroup);
export const apiEnvSchema = z
  .looseObject(apiShape)
  .superRefine(checkRotationKeys)
  .superRefine(checkMailGroup)
  .superRefine(checkVerificationNeedsMail)
  .superRefine(checkCronTrigger);

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
