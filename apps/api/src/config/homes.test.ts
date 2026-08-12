import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declaredVars, type ProcessName, requiredVars } from "./schema";

// A new variable has four homes, and nothing checks any of them. `.env.example`
// documents it, docker-compose runs the dev stack on it, the integration and e2e
// suites spawn processes with it, and the Helm chart is what a deployment
// actually gets — and the only thing that has ever caught a missing one is a
// deployment failing. This is that check: the schema is the source of truth, and
// every home is held to it.
//
// Read as text rather than rendered. `helm template` would be the honest render,
// but the unit suite must not need helm installed, and what is being asserted is
// that the chart NAMES the variable at all — which survives a text read.

const ROOT = join(__dirname, "..", "..", "..", "..");
const CHART = join(ROOT, "deploy", "helm", "indexterity", "templates");

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

// Expand `{{- include "indexterity.coreEnv" . }}` against the defines in
// _helpers.tpl, so a deployment that gets its variables through a helper is read
// the same way as one that spells them out.
//
// A define runs to the LAST `end` before the next one rather than the first:
// coreEnv wraps MASTER_KEY_VERSION in an `if`, and stopping at that `end` would
// silently credit the chart with none of the variables after it.
function helperDefines(): Map<string, string> {
  const helpers = read(CHART, "_helpers.tpl");
  const defines = new Map<string, string>();
  const chunks = helpers.split(/\{\{-?\s*define\s+"/);
  for (const chunk of chunks.slice(1)) {
    const name = chunk.slice(0, chunk.indexOf('"'));
    const body = chunk.slice(chunk.indexOf("}}") + 2);
    const lastEnd = body.lastIndexOf("{{- end -}}");
    defines.set(name, lastEnd === -1 ? body : body.slice(0, lastEnd));
  }
  return defines;
}

function expandIncludes(template: string): string {
  const defines = helperDefines();
  return template.replace(/\{\{-?\s*include\s+"([^"]+)"[\s\S]*?\}\}/g, (whole, name: string) => {
    return defines.get(name) ?? whole;
  });
}

function envNamesIn(text: string): Set<string> {
  const names = new Set<string>();
  // A name may end in a templated segment: the rotation's keys are emitted by a
  // `range` over secrets.masterKeys as `MASTER_KEY_V{{ $version }}`. That value
  // stands for a version number, so a `1` is substituted and the family is then
  // held to the same shape rule as everything else — rather than widening that
  // rule to accept a bare `MASTER_KEY_V`, which is what the raw template text
  // reads as, and which would accept a misspelling of it too.
  for (const match of text.matchAll(
    /^[\t ]*-[\t ]*name:[\t ]*([A-Z][A-Z0-9_]*)(\{\{[^}]*\}\})?/gm,
  )) {
    names.add(match[2] === undefined ? (match[1] as string) : `${match[1]}1`);
  }
  return names;
}

const chartEnv: Record<ProcessName, Set<string>> = {
  api: envNamesIn(expandIncludes(read(CHART, "api-deployment.yaml"))),
  worker: envNamesIn(expandIncludes(read(CHART, "worker-deployment.yaml"))),
  migrate: envNamesIn(expandIncludes(read(CHART, "migrate-job.yaml"))),
};

// docker-compose, split per service so the api's block is not credited with what
// only the worker sets.
function composeEnv(service: string): Set<string> {
  const text = read(ROOT, "docker-compose.yml");
  const start = text.indexOf(`\n  ${service}:\n`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n {2}\w[\w-]*:\n/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const names = new Set<string>();
  for (const match of block.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)) names.add(match[1] as string);
  return names;
}

function exampleEnv(): Set<string> {
  const names = new Set<string>();
  // Commented-out entries count: `# RATE_LIMIT_MAX=300` under a paragraph
  // explaining it is how this file documents an optional knob.
  for (const match of read(ROOT, ".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    names.add(match[1] as string);
  }
  return names;
}

// Set by the runtime image itself (Dockerfile `ENV NODE_ENV=production`), so no
// home has to name it and a chart that did would be overriding the image.
const FROM_THE_IMAGE = new Set(["NODE_ENV"]);

// Configure the node RUNTIME rather than this application, so no schema declares
// them and none should. The chart sets NODE_OPTIONS to cap V8's heap below the
// container's memory limit — node's own sizing stops scaling down at ~262 MB, so
// under a small limit a process would otherwise believe it may hold more heap
// than the cgroup allows.
const NODE_RUNTIME_VARS = new Set(["NODE_OPTIONS"]);

// The dashboard server's own variables, whose schema lives in
// apps/web/src/lib/env.ts. Named here because the chart sets all four in one
// place and the drift check below would otherwise read them as unknown.
const WEB_VARS = new Set(["API_URL", "PORT", "SITE_URL", "TRUST_PROXY"]);

// Postgres' own configuration in the dev stack — the container's, not ours.
const COMPOSE_INFRA = new Set(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]);

// Set by the DEPLOYMENT rather than by the app: compose maps two Sentry projects
// onto one SENTRY_DSN per container, and .env.example is where an operator puts
// the two DSNs to be mapped from.
const DEPLOYMENT_ONLY = new Set(["SENTRY_DSN_API", "SENTRY_DSN_WEB"]);

// Read by the all-in-one image's supervisor (deploy/all-in-one/supervisor.mjs)
// and by neither process. That image runs the api and the dashboard in one
// container, so one environment has to describe two of them — and these are the
// two variables they would otherwise fight over: both read METRICS_PORT (one
// network namespace, so the second listener has to move) and both read
// SENTRY_DSN (two projects). The supervisor splits them and hands each process
// the name it already reads, which is why no schema declares these.
const SUPERVISOR_VARS = new Set(["WEB_METRICS_PORT", "WEB_SENTRY_DSN"]);

describe("every required variable is registered in every home", () => {
  // The gap #126 names: a required variable the chart does not set is a
  // CrashLoopBackOff, discovered by deploying.
  it.each(["api", "worker", "migrate"] as const)(
    "the chart gives %s what it demands",
    (process) => {
      for (const name of requiredVars(process)) {
        expect(chartEnv[process], `${name} is required by the ${process} schema`).toContain(name);
      }
    },
  );

  it("docker-compose runs the dev stack on the same required set", () => {
    for (const name of requiredVars("api")) expect(composeEnv("api")).toContain(name);
    for (const name of requiredVars("worker")) expect(composeEnv("worker")).toContain(name);
  });

  it(".env.example documents every variable a process cannot start without", () => {
    const documented = exampleEnv();
    for (const name of requiredVars("api")) expect(documented).toContain(name);
  });
});

// Drift the other way, which is the half nothing could catch before: a variable
// set by a home that no schema knows about is either a typo (REQUIRE_OWNER_2FA
// misspelt in the chart reads as "off" forever) or a leftover of something the
// code stopped reading.
describe("nothing is set that no schema knows", () => {
  const known = new Set([
    ...declaredVars("api"),
    ...WEB_VARS,
    ...DEPLOYMENT_ONLY,
    ...COMPOSE_INFRA,
    ...SUPERVISOR_VARS,
    ...NODE_RUNTIME_VARS,
  ]);
  // MASTER_KEY_V<n> is dynamically named by the rotation, so it is matched by
  // shape rather than listed.
  const isKnown = (name: string): boolean => known.has(name) || /^MASTER_KEY_V\d+$/.test(name);

  it.each(["api", "worker", "migrate"] as const)("the chart's %s env is all known", (process) => {
    for (const name of chartEnv[process]) {
      expect(isKnown(name), `${name} is set by the chart and no schema declares it`).toBe(true);
    }
  });

  it.each(["api", "worker", "web"])("docker-compose's %s env is all known", (service) => {
    for (const name of composeEnv(service)) {
      expect(isKnown(name), `${name} is set by docker-compose and no schema declares it`).toBe(
        true,
      );
    }
  });

  it(".env.example documents nothing that has stopped existing", () => {
    for (const name of exampleEnv()) {
      expect(isKnown(name), `${name} is documented in .env.example and no schema declares it`).toBe(
        true,
      );
    }
  });
});

// The suites are the third home, and the one a stricter boot breaks first: they
// spawn the api with a deliberately partial environment.
//
// DATABASE_URL is the one required variable they inherit rather than supply: it
// has to point at a migrated postgres, so there is no value either suite could
// invent, and both CI and the local instructions export it for the whole run.
// Everything else is named with a working default, because a developer's shell
// has no reason to carry a master key.
const INHERITED = new Set(["DATABASE_URL"]);

describe("the test suites spawn processes the schema accepts", () => {
  it.each([
    ["the integration suite", join(ROOT, "apps", "api", "integration", "helpers.ts")],
    ["the e2e suite", join(ROOT, "apps", "web", "playwright.config.ts")],
  ])("%s supplies every required variable", (_label, path) => {
    const text = readFileSync(path, "utf8");
    expect(text, "the ambient environment is forwarded to the spawned api").toContain(
      "...process.env",
    );
    const missing = requiredVars("api").filter(
      (name) => !INHERITED.has(name) && !new RegExp(`\\b${name}\\b`).test(text),
    );
    expect(missing, "required to start the api, and this suite supplies no value").toEqual([]);
  });
});

// Everything the api declares has SOME home, or it is a knob only its own source
// mentions — which is how RETENTION_DAYS and the rate limits spent a release
// being settable by nothing but `extraEnv`.
it("every declared variable is reachable from at least one home", () => {
  const homes = new Set([
    ...chartEnv.api,
    ...chartEnv.worker,
    ...composeEnv("api"),
    ...composeEnv("worker"),
    ...exampleEnv(),
  ]);
  const orphans = declaredVars("api").filter(
    (name) => !FROM_THE_IMAGE.has(name) && !homes.has(name),
  );
  expect(orphans, "declared by the api schema and settable from no home").toEqual([]);
});
