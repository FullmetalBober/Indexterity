import type { z } from "zod";
import type { Plan } from "../billing/plans";
import {
  type ApiEnv,
  cidrEntries,
  decodeKey,
  isSecretVar,
  type MigrateEnv,
  PROCESS_SCHEMAS,
  type ProcessName,
  type TrustProxy,
  type WorkerEnv,
  withoutBlanks,
} from "./schema";

// The one place in the api that reads process.env, and the one moment it is
// read: `loadEnv` at the top of an entrypoint. Everything downstream asks this
// module instead, so a variable's meaning is decided once, in ./schema.ts, and a
// deployment that is misconfigured says so before it serves a request.
//
// Deliberately NOT lazy. A schema that validated on first use would fail-fast
// for whatever happened to be read first and go on hiding the rest, which is the
// behaviour #126 is about: `requiredEnv` threw at import time in auth/index.ts
// and at request time everywhere else, so which variables a deployment was
// missing depended on which endpoint someone called.

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

let loaded: { readonly process: ProcessName; readonly values: Record<string, unknown> } | null =
  null;

// What to do about it, for the variables where "required" alone leaves the
// reader looking for a value they have to generate rather than find.
const MISSING_HINTS: Record<string, string> = {
  DATABASE_URL: "the control-plane postgres, e.g. postgres://user:pass@host:5432/indexterity",
  MASTER_KEY:
    "the key that unseals stored cluster credentials. Generate one with `openssl rand -base64 32` and back it up — losing it makes every stored connection string unreadable",
  BETTER_AUTH_SECRET: "the session signing key. Generate one with `openssl rand -base64 32`",
  CRON_TRIGGER_SECRET:
    "the bearer token GET /api/internal/tick demands. RUN_CRONJOB=false installs no schedule, so that endpoint is the only thing that can start a pass. Generate one with `openssl rand -hex 32`",
};

// One line per bad variable: what it is, what was expected, and — unless it
// holds a secret — what arrived. Secrets are named but never printed: a config
// error should not be the thing that puts MASTER_KEY in a log aggregator.
//
// An absent required variable gets its own wording. Zod says "expected string,
// received undefined", which is true and useless to the person reading it in a
// CrashLoopBackOff; the refinement that would have explained the value never
// runs, because there is no value.
function report(process: ProcessName, raw: Record<string, string>, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = String(issue.path[0] ?? "(root)");
    const value = raw[name];
    if (value === undefined) {
      const hint = MISSING_HINTS[name];
      return `  ${name}: required${hint === undefined ? "" : ` — ${hint}`}`;
    }
    const got = isSecretVar(name) ? "" : ` (got ${JSON.stringify(value)})`;
    return `  ${name}: ${issue.message}${got}`;
  });
  return [
    `the environment is not valid for the ${process} process:`,
    "",
    ...[...new Set(lines)],
    "",
    "See .env.example for what each variable is for.",
  ].join("\n");
}

// Validate the environment for this process and remember the result. Called
// once, first thing, by every entrypoint — main.ts, migrate.ts, rotate-key.ts,
// set-plan.ts.
export function loadEnv(process: ProcessName, raw: NodeJS.ProcessEnv = globalThis.process.env) {
  const present = withoutBlanks(raw);
  const result = PROCESS_SCHEMAS[process].safeParse(present);
  if (!result.success) throw new EnvironmentError(report(process, present, result.error));
  loaded = { process, values: result.data as Record<string, unknown> };
  return result.data;
}

// The same, for an entrypoint: a misconfiguration is not a fault, so it prints
// what is wrong and exits rather than unwinding as an unhandled throw. The stack
// of a config error says only that the config was loaded, and it is what an
// operator reading a CrashLoopBackOff has to scroll past to reach the six lines
// that matter.
export function loadEnvOrExit(process: ProcessName): void {
  try {
    loadEnv(process);
  } catch (error) {
    if (!(error instanceof EnvironmentError)) throw error;
    console.error(error.message);
    globalThis.process.exit(1);
  }
}

// Test-only escape hatch. Unit tests load a valid environment once (see
// vitest.setup.ts); the few that are ABOUT a variable's meaning re-load with
// their own and put this back.
export function resetEnv(): void {
  loaded = null;
}

function current(allowed: readonly ProcessName[], accessor: string): Record<string, unknown> {
  if (loaded === null) {
    throw new EnvironmentError(
      `${accessor}() was called before loadEnv() — an entrypoint has to validate the environment first`,
    );
  }
  if (!allowed.includes(loaded.process)) {
    throw new EnvironmentError(
      `${accessor}() is not available to the ${loaded.process} process, which does not validate those variables`,
    );
  }
  return loaded.values;
}

// The floor every process shares: Postgres, logging, error reporting. The Helm
// pre-install migration hook is given DATABASE_URL and nothing else, so this is
// as much as that Job may ask for.
export function coreEnv(): MigrateEnv {
  return current(["api", "worker", "migrate"], "coreEnv") as MigrateEnv;
}

// The pipeline's variables: the master key, the plans, the cluster-dialling
// guards, mail, metrics. The api validates them as part of its own shape; the
// "worker" process name survives the worker process (#232) as the narrower
// validation the rotate-key CLI runs under, since that tool unseals credentials
// without ever being given the api's HTTP half.
export function workerEnv(): WorkerEnv {
  return current(["api", "worker"], "workerEnv") as WorkerEnv;
}

// The api's own half: HTTP, auth, the rate limits, the sign-up posture. Not
// reachable from the rotate-key CLI, which validates workerShape and is never
// given BETTER_AUTH_SECRET.
export function apiEnv(): ApiEnv {
  return current(["api"], "apiEnv") as ApiEnv;
}

// ── Derived accessors ────────────────────────────────────────────────────────
// The readers that used to live in src/env.ts, now sitting on validated values
// instead of parsing for themselves.

export function masterKeyBytes(): Uint8Array {
  return decodeKey(workerEnv().MASTER_KEY);
}

// KEK rotation: MASTER_KEY_V<n> for every n, with MASTER_KEY as v1's fallback.
// Each cluster row records the version that sealed it, so old rows stay readable
// during a rotation. The schema has already checked that every version up to
// MASTER_KEY_VERSION has a well-formed key behind it.
export function masterKeyBytesFor(version: number): Uint8Array {
  const values: Record<string, unknown> = workerEnv();
  // Every version can be named `MASTER_KEY_V<n>`, version 1 included, and
  // MASTER_KEY is what v1 falls back to.
  //
  // v1 used to be MASTER_KEY and nothing else, which made the first key the one
  // key that could never be retired by name: after rotating to v2, the variable
  // called MASTER_KEY had to go on holding the OLD value for as long as any v1
  // row survived — so the live key was MASTER_KEY_V2 and the retired one was
  // MASTER_KEY, which reads backwards and is a thing to get wrong under pressure.
  // Naming it makes the rotation symmetric: MASTER_KEY_V1 is the retired key,
  // MASTER_KEY_V2 is the current one, and rotate-key.js re-seals across them.
  //
  // Fallback rather than replacement, so every existing deployment keeps working
  // untouched. Note the consequence when MASTER_KEY_VERSION is still 1 and
  // MASTER_KEY_V1 is set: NEW rows seal with MASTER_KEY_V1 too, because that is
  // what version 1's key now is. Setting it without bumping the version is how
  // you would write new rows with a key you meant to retire.
  const raw = values[`MASTER_KEY_V${version}`] ?? (version <= 1 ? values.MASTER_KEY : undefined);
  if (typeof raw !== "string") {
    // A row sealed with a version this deployment was never given. Not a config
    // error the schema could have caught — MASTER_KEY_VERSION says which key
    // NEW rows use, and an older row can name a key that was retired.
    throw new EnvironmentError(
      `missing MASTER_KEY_V${version}: a stored credential was sealed with key version ${version}`,
    );
  }
  return decodeKey(raw);
}

// The version new seals are written with.
export function currentKeyVersion(): number {
  return workerEnv().MASTER_KEY_VERSION;
}

// Fastify's trustProxy. Behind an ingress or a Service every request arrives
// from the proxy, so `request.ip` is the proxy's address and both rate limiters
// — Fastify's and better-auth's — collapse from per-client budgets into one
// global bucket.
export function trustProxySetting(): TrustProxy {
  return apiEnv().TRUST_PROXY;
}

export function trustsProxy(): boolean {
  return trustProxySetting() !== false;
}

// The CIDR entries of TRUST_PROXY, for better-auth, which needs to know WHICH
// hops to distrust rather than only that a proxy exists.
export function trustedProxyCidrs(): string[] {
  const value = apiEnv().TRUST_PROXY;
  return typeof value === "string" ? cidrEntries(value) : [];
}

// Whether owners must have a second factor before any owner-only mutation (#55).
// A deployment posture like SIGNUP_MODE, off by default so dev and the test
// suites work without every account enrolling an authenticator first.
export function requireOwnerTwoFactor(): boolean {
  return apiEnv().REQUIRE_OWNER_2FA;
}

// The plan a newly created organization lands on. FREE unless the deployment
// says otherwise; the chart says SELF_HOSTED, which is what the licence grants
// someone running it on their own hardware.
export function defaultOrgPlan(): Plan {
  return workerEnv().DEFAULT_ORG_PLAN;
}

// RETENTION_DAYS is the operator's ceiling, not the plan's number. Storage is
// the operator's bill, so they can cap it; a plan may keep less than the cap but
// never more. Unset means the plan decides on its own.
export function operatorCeilingDays(): number {
  return workerEnv().RETENTION_DAYS ?? Number.POSITIVE_INFINITY;
}
