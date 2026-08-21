import { describe, expect, it } from "vitest";
import { apiEnv, EnvironmentError, loadEnv, masterKeyBytesFor } from "./env";
import { cidrEntries, requiredVars, trustProxyFrom, withoutBlanks } from "./schema";

const MASTER_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

// A minimum valid environment for each process, so a case can say what it is
// about in one line.
const MIGRATE = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };
const WORKER = { ...MIGRATE, MASTER_KEY };
const API = { ...WORKER, BETTER_AUTH_SECRET: "secret" };

function parse(process: "api" | "worker" | "migrate", raw: Record<string, string>) {
  return loadEnv(process, raw as NodeJS.ProcessEnv);
}

function refusal(process: "api" | "worker" | "migrate", raw: Record<string, string>): string {
  try {
    parse(process, raw);
  } catch (error) {
    if (error instanceof EnvironmentError) return error.message;
    throw error;
  }
  throw new Error("expected the environment to be refused");
}

// The rule the old readers were reaching for and could not express. Both halves
// matter: an unset optional knob must still fall back, or every deployment would
// have to spell out defaults it does not care about.
describe("absent is fine, malformed is fatal", () => {
  it("falls back when a knob is unset", () => {
    const env = parse("api", API);
    expect(env.AUTH_RATE_LIMIT_MAX).toBe(20);
    expect(env.RATE_LIMIT_MAX).toBe(300);
    expect(env.SMTP_PORT).toBe(465);
    expect(env.SIGNUP_MODE).toBe("invite");
    expect(env.REQUIRE_OWNER_2FA).toBe(false);
  });

  // The case #126 opens with: `2O` is not a positive number, so positiveEnv read
  // it as the default and a fat-fingered brute-force budget looked correct.
  it("refuses a typo where the old reader silently used the default", () => {
    const message = refusal("api", { ...API, AUTH_RATE_LIMIT_MAX: "2O" });
    expect(message).toContain("AUTH_RATE_LIMIT_MAX");
    expect(message).toContain("expected a positive number");
    expect(message).toContain('"2O"');
  });

  it("refuses zero and a negative, which are not budgets", () => {
    expect(refusal("api", { ...API, RATE_LIMIT_MAX: "0" })).toContain("RATE_LIMIT_MAX");
    expect(refusal("api", { ...API, WORKER_CONCURRENCY: "-1" })).toContain("WORKER_CONCURRENCY");
    expect(refusal("api", { ...API, WORKER_CONCURRENCY: "2x" })).toContain(
      "expected a positive whole number",
    );
  });

  // Truthiness is not a dialect anything in this repo writes: the chart quotes
  // its booleans and compose quotes its strings, so `1` is a mistake and reading
  // it as "off" is how REQUIRE_OWNER_2FA=1 would silently disable a second
  // factor on the accounts that can flip a customer's cluster live.
  it("refuses a truthy-looking flag rather than reading it as off", () => {
    expect(refusal("api", { ...API, REQUIRE_OWNER_2FA: "1" })).toContain("REQUIRE_OWNER_2FA");
    expect(refusal("api", { ...API, ALLOW_INSECURE_CLUSTER_TLS: "yes" })).toContain(
      "ALLOW_INSECURE_CLUSTER_TLS",
    );
  });

  it("refuses a sign-up posture it does not recognise", () => {
    expect(refusal("api", { ...API, SIGNUP_MODE: "invites" })).toContain("SIGNUP_MODE");
    expect(parse("api", { ...API, SIGNUP_MODE: "open" }).SIGNUP_MODE).toBe("open");
  });
});

// RUN_CRONJOB=false installs no crontab, so the tick endpoint is the only thing
// that can start a pass. Booting without its secret would leave the one state
// where nothing can ever run and nothing says so.
describe("the external schedule needs a way in", () => {
  it("refuses RUN_CRONJOB=false with no secret", () => {
    const message = refusal("api", { ...API, RUN_CRONJOB: "false" });
    expect(message).toContain("CRON_TRIGGER_SECRET");
    // The absent-variable path replaces zod's wording with the hint in env.ts,
    // which is where a reader in a CrashLoopBackOff will actually see it.
    expect(message).toContain("only thing that can start a pass");
  });

  // The token authorises the whole pipeline against nothing but the global
  // per-IP budget, so a short one is refused rather than warned about.
  it("refuses a secret short enough to guess", () => {
    expect(
      refusal("api", { ...API, RUN_CRONJOB: "false", CRON_TRIGGER_SECRET: "short" }),
    ).toContain("at least 32 characters");
  });

  it("accepts a long one", () => {
    const env = parse("api", { ...API, RUN_CRONJOB: "false", CRON_TRIGGER_SECRET: "a".repeat(32) });
    expect(env.RUN_CRONJOB).toBe(false);
  });

  // The default is what every install had before the flag existed: whichever
  // process runs the worker also owns the schedule.
  it("owns its own schedule by default, and then wants no secret", () => {
    expect(parse("api", API).RUN_CRONJOB).toBe(true);
  });
});

// Compose passes `SMTP_HOST: ${SMTP_HOST}` through as "" when the .env file has
// no value, and Helm renders an unset value the same way. Telling those apart
// from unset would refuse to boot on the stacks this repo ships.
describe("an empty value is an absent one", () => {
  it("drops blanks before validating", () => {
    expect(withoutBlanks({ A: "", B: "  ", C: "x", D: undefined })).toEqual({ C: "x" });
  });

  it("takes the default rather than failing on an empty optional", () => {
    expect(parse("api", { ...API, SMTP_HOST: "", GITHUB_CLIENT_ID: "" }).SMTP_HOST).toBeUndefined();
  });

  it("still refuses an empty REQUIRED value", () => {
    expect(refusal("api", { ...API, DATABASE_URL: "" })).toContain("DATABASE_URL");
  });
});

// One schema per process, and the differences are the ones the deployment
// already makes: the chart's worker Deployment sets no BETTER_AUTH_SECRET, and
// its pre-install migration Job is given DATABASE_URL and nothing else.
describe("one schema per process", () => {
  it("asks the api for what only the api serves", () => {
    expect(requiredVars("api")).toContain("BETTER_AUTH_SECRET");
    expect(requiredVars("worker")).not.toContain("BETTER_AUTH_SECRET");
    expect(requiredVars("migrate")).not.toContain("BETTER_AUTH_SECRET");
  });

  // The open question in #126, answered: a worker without MASTER_KEY starts
  // cleanly today and fails at the first job that opens a cluster, as a decrypt
  // error hours after the deploy that caused it.
  it("refuses a worker with no master key", () => {
    expect(refusal("worker", MIGRATE)).toContain("MASTER_KEY");
    expect(() => parse("worker", WORKER)).not.toThrow();
  });

  it("lets the migration run on a database URL alone", () => {
    expect(() => parse("migrate", MIGRATE)).not.toThrow();
    expect(refusal("migrate", {})).toContain("DATABASE_URL");
  });

  it("refuses a database URL that is not postgres", () => {
    expect(refusal("migrate", { DATABASE_URL: "mysql://h/db" })).toContain("postgres");
  });

  // Reading an api-only value out of the worker is a defect in the code, not in
  // the deployment, so it says so rather than returning a default.
  it("does not answer for variables its process never validated", () => {
    parse("worker", WORKER);
    expect(() => apiEnv()).toThrow(/not available to the worker process/);
    parse("api", API);
  });
});

// Buffer.from(x, "base64") never throws — it drops what it cannot read — so a
// truncated key used to produce a short one that xchacha20poly1305 rejected
// hours later, inside a job, with a message about a nonce.
describe("MASTER_KEY", () => {
  it("wants 32 bytes of base64 and says how to make one", () => {
    const message = refusal("worker", { ...WORKER, MASTER_KEY: "too short" });
    expect(message).toContain("MASTER_KEY");
    expect(message).toContain("openssl rand -base64 32");
  });

  // Never printed. A config error should not be the thing that puts the key
  // that unseals every stored connection string into a log aggregator.
  it("names the variable without printing what was in it", () => {
    const message = refusal("worker", { ...WORKER, MASTER_KEY: "s3cr3t-but-wrong" });
    expect(message).not.toContain("s3cr3t-but-wrong");
  });

  // The rotation's one unrecoverable mistake: bump the version, forget the key,
  // and every row sealed from then on is unreadable.
  it("refuses a rotation whose version names a key that is not there", () => {
    const message = refusal("worker", { ...WORKER, MASTER_KEY_VERSION: "2" });
    expect(message).toContain("MASTER_KEY_V2");
  });

  it("accepts the rotation once both keys are present", () => {
    const env = parse("worker", { ...WORKER, MASTER_KEY_VERSION: "2", MASTER_KEY_V2: MASTER_KEY });
    expect(env.MASTER_KEY_VERSION).toBe(2);
  });

  it("checks the rotation key as strictly as the first one", () => {
    expect(
      refusal("worker", { ...WORKER, MASTER_KEY_VERSION: "2", MASTER_KEY_V2: "short" }),
    ).toContain("MASTER_KEY_V2");
  });

  // A rotation key is a KEK, and the report used a literal set of secret NAMES —
  // which dynamic ones can never be in. So the refusal above printed the value
  // it rejected, putting key material in the boot log of the process that
  // refused to start.
  it("never prints a rotation key it is rejecting", () => {
    const message = refusal("worker", {
      ...WORKER,
      MASTER_KEY_VERSION: "2",
      MASTER_KEY_V2: "kek-material-that-must-not-be-logged",
    });
    expect(message).toContain("MASTER_KEY_V2");
    expect(message).not.toContain("kek-material-that-must-not-be-logged");
  });

  // v1 can be named too, which is what lets a retired key be supplied as
  // MASTER_KEY_V1 instead of having to sit in MASTER_KEY while MASTER_KEY_V2
  // holds the live one.
  it("checks MASTER_KEY_V1 when it is named, and does not require it", () => {
    expect(parse("worker", { ...WORKER, MASTER_KEY_V1: MASTER_KEY }).MASTER_KEY_VERSION).toBe(1);
    expect(refusal("worker", { ...WORKER, MASTER_KEY_V1: "short" })).toContain("MASTER_KEY_V1");
    expect(refusal("worker", { ...WORKER, MASTER_KEY_V1: "short" })).not.toContain("short");
  });

  // Which key version 1 actually resolves to. MASTER_KEY alone still answers it,
  // which is every deployment that exists; a named MASTER_KEY_V1 takes
  // precedence, which is what makes a retired first key supplyable by name.
  it("resolves version 1 to MASTER_KEY_V1 when named, else MASTER_KEY", () => {
    const other = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");

    parse("worker", WORKER);
    expect(Buffer.from(masterKeyBytesFor(1)).toString("base64")).toBe(MASTER_KEY);

    parse("worker", { ...WORKER, MASTER_KEY_V1: other });
    expect(Buffer.from(masterKeyBytesFor(1)).toString("base64")).toBe(other);

    // And a version with nothing behind it is still the same refusal, named.
    parse("worker", WORKER);
    expect(() => masterKeyBytesFor(3)).toThrow(/MASTER_KEY_V3/);
  });
});

// Behind an ingress, an untrusted forwarded address turns every per-IP rate
// limit into one shared bucket; a blindly trusted one lets a client forge a
// fresh address per request. Both failures are silent, so the parsing is worth
// pinning.
describe("TRUST_PROXY", () => {
  it("does not trust anything by default", () => {
    expect(parse("api", API).TRUST_PROXY).toBe(false);
  });

  it("reads the three dialects Fastify accepts", () => {
    expect(parse("api", { ...API, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(parse("api", { ...API, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
    expect(parse("api", { ...API, TRUST_PROXY: "10.0.0.0/8,192.168.0.0/16" }).TRUST_PROXY).toBe(
      "10.0.0.0/8,192.168.0.0/16",
    );
  });

  // The failure this replaces. `ture` and a list with one bad range both read as
  // "nothing in front", and the deployment served on with one shared bucket.
  it("refuses a value that is none of them", () => {
    expect(refusal("api", { ...API, TRUST_PROXY: "ture" })).toContain("TRUST_PROXY");
    expect(refusal("api", { ...API, TRUST_PROXY: "10.0.0.0/8,nonsense" })).toContain("TRUST_PROXY");
  });

  it("trims before deciding", () => {
    expect(parse("api", { ...API, TRUST_PROXY: " true " }).TRUST_PROXY).toBe(true);
    expect(trustProxyFrom(" 2 ")).toBe(2);
  });
});

// The same variable, read a second way. Fastify takes "true" and a hop count;
// better-auth takes neither and needs the ranges by name, or it cannot tell the
// client from the proxy in a two-hop X-Forwarded-For and puts every caller in one
// rate-limit bucket (#54).
describe("cidrEntries", () => {
  it("keeps the ranges of a CIDR list", () => {
    expect(cidrEntries("10.0.0.0/8, 192.168.0.0/16")).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });

  it("keeps a bare address, which is a /32 by any other name", () => {
    expect(cidrEntries("10.4.1.7")).toEqual(["10.4.1.7"]);
  });

  it("keeps IPv6 ranges", () => {
    expect(cidrEntries("fd00::/8")).toEqual(["fd00::/8"]);
  });

  // "true" and "2" are Fastify's dialects, and handing either to better-auth as a
  // range would be a list it silently never matches.
  it("drops what is not an address at all", () => {
    for (const value of ["true", "false", "2", "", "  "]) {
      expect(cidrEntries(value)).toEqual([]);
    }
    expect(cidrEntries(undefined)).toEqual([]);
  });
});

// A host with no credentials builds no transport, so the deployment sends
// nothing while every invitation, reset and emailed two-factor code reports
// success. Sending is still entirely optional — leaving SMTP_HOST unset is how a
// deployment says so.
describe("SMTP", () => {
  it("is off when there is no host", () => {
    expect(() => parse("worker", WORKER)).not.toThrow();
  });

  it("refuses a host with half its credentials, and names the missing half", () => {
    const message = refusal("worker", { ...WORKER, SMTP_HOST: "smtp.example.com" });
    expect(message).toContain("SMTP_USER");
    expect(message).toContain("SMTP_PASS");
  });

  it("takes a complete configuration", () => {
    const env = parse("worker", {
      ...WORKER,
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "postmaster@example.com",
      SMTP_PASS: "hunter2",
      MAIL_FROM: "indexterity@example.com",
    });
    expect(env.SMTP_PORT).toBe(465);
  });

  // The combination that has no way out, and which locked the hosted
  // deployment's own owner out of it (#306): verification required, mail
  // impossible. Sign-up succeeds, the send is a logged no-op, and sign-in is
  // refused forever — for every account on the install, not just the first.
  it("refuses verification-required with no way to send the verification", () => {
    const message = refusal("api", { ...API, REQUIRE_EMAIL_VERIFICATION: "true" });
    // Named against the flag, not the absent SMTP_HOST: config/env.ts prints a
    // bare "required" for a path with no value and would drop the explanation.
    expect(message).toContain("REQUIRE_EMAIL_VERIFICATION");
    expect(message).toContain("SMTP_HOST");
    expect(message).toContain("locked out");
  });

  it("takes verification-required once mail is configured", () => {
    const env = parse("api", {
      ...API,
      REQUIRE_EMAIL_VERIFICATION: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "u",
      SMTP_PASS: "p",
    });
    expect(env.REQUIRE_EMAIL_VERIFICATION).toBe(true);
  });

  // The default is off, so an install with no mail at all still boots — which is
  // the self-hosted default and must keep working.
  it("leaves an install with no mail and no verification alone", () => {
    expect(() => parse("api", API)).not.toThrow();
    expect(parse("api", API).REQUIRE_EMAIL_VERIFICATION).toBe(false);
  });

  it("refuses a from-address that is not one", () => {
    expect(
      refusal("worker", {
        ...WORKER,
        SMTP_HOST: "smtp.example.com",
        SMTP_USER: "u",
        SMTP_PASS: "p",
        MAIL_FROM: "Indexterity <indexterity@example.com>",
      }),
    ).toContain("MAIL_FROM");
  });
});

describe("the refusal itself", () => {
  it("names the process and every bad variable at once", () => {
    const message = refusal("api", { ...API, RATE_LIMIT_MAX: "lots", SIGNUP_MODE: "sometimes" });
    expect(message).toContain("the api process");
    expect(message).toContain("RATE_LIMIT_MAX");
    expect(message).toContain("SIGNUP_MODE");
  });

  it("points at where the variables are documented", () => {
    expect(refusal("migrate", {})).toContain(".env.example");
  });
});
