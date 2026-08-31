#!/usr/bin/env node
// `npm audit` as a gate, on the half of the tree that ships.
//
// A bare `npm audit` in CI is a gate nobody can pass: it counts the dev-server
// advisory in drizzle-kit's bundled esbuild the same as a hole in the HTTP
// router, so the honest response to a red build is to stop reading it. This
// fails on **high and critical advisories reachable from something we ship**,
// and says nothing about a build tool that never leaves the runner — which is
// the distinction #21 asked for.
//
// Every exception is written down here, with a reason and the condition that
// retires it. An advisory that is merely old is not an exception; an advisory
// that cannot be reached from how this code is deployed is.
//
// ── Why the reachability is computed here rather than by npm ────────────────
// `npm audit --omit=dev` is the obvious answer and does not work in this repo:
// the runtime and dev trees are hoisted into one node_modules and the lockfile
// carries no `dev` flag for a workspace's devDependencies, so npm reports the
// same 6 advisories with the flag as without it (measured, Aug 2026). So the
// walk below does it from the lockfile: start at each workspace's
// `dependencies` — never its devDependencies — and follow `dependencies` and
// `optionalDependencies` through node resolution. What that set reaches is what
// a container runs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Severities that stop a release. Moderate and below are reported and not
// enforced: the line has to be somewhere, and a gate that fires on everything
// gets switched off rather than argued with.
const BLOCKING = new Set<Severity>(["high", "critical"]);

// ── The two shapes this reads, neither of them ours ─────────────────────────
//
// Written out by hand and narrow rather than pulled from a package: six fields
// of `package-lock.json` and four of `npm audit --json` are the whole of what
// is touched, and a type that claims more than that is a type nobody trusts.
// Both are external schemas that will move — `auditReportVersion: 2` says so on
// its face — and the point of naming them is that the move becomes a type
// error instead of an empty result.

type Severity = "info" | "low" | "moderate" | "high" | "critical";

/** An entry in `package-lock.json`'s `packages` map. */
type LockNode = {
  /** A workspace: the real entry is the directory named by `resolved`. */
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /**
   * Declared so the fixtures below can state one, and deliberately never read:
   * a workspace's dev tree is exactly what this gate is meant to leave out.
   */
  devDependencies?: Record<string, string>;
};

type LockPackages = Record<string, LockNode>;

/** One advisory, as `npm audit --json` states it inside a `via` array. */
type AuditAdvisory = {
  source?: number;
  title?: string;
  severity: Severity;
  url?: string;
};

type AuditVulnerability = {
  /** The paths in node_modules this package was found at. */
  nodes?: string[];
  /** An advisory, or the name of another package whose advisory this inherits. */
  via: Array<string | AuditAdvisory>;
};

type AuditReport = {
  auditReportVersion?: number;
  vulnerabilities?: Record<string, AuditVulnerability>;
  metadata?: { vulnerabilities?: { total?: number } };
};

/** One advisory, collected across every package it was reported against. */
type Advisory = {
  id: string;
  title: string;
  severity: Severity;
  url: string | undefined;
  packages: Set<string>;
  runtime: boolean;
};

/** A high or critical advisory we have looked at and are carrying on purpose. */
type Exception = {
  /** The advisory, NOT the package. */
  id: string;
  /** For the message only. */
  package: string;
  /** One line, the reason it cannot be reached from this deployment. */
  why: string;
  /** The condition that ends it, in words. */
  until: string;
};

// Advisories we have looked at and are carrying on purpose.
//
// Empty, and that is the intended resting state rather than a sign nobody has
// filled it in. An entry here is a high or critical advisory that a container
// runs and that we are shipping anyway, which should be rare enough to argue
// about each time.
//
// `id` is the GHSA identifier rather than the package name, so a NEW advisory
// against an already-excepted package still fails the build. `until` is a
// condition rather than a date, because a date is only ever a reminder to move
// the date — and the check below fails when an accepted advisory stops being
// reported, so a condition that comes true removes the entry rather than
// leaving it to be believed.
//
// That is not theoretical. This list held GHSA-c96f-x56v-gq3h (find-my-way's
// HTTP/2 DDoS, unreachable because the FastifyAdapter never enables HTTP/2)
// until @nestjs/platform-fastify@11.1.29 shipped find-my-way 9.7.0 — exactly the
// `until` that was written down — and the gate failed on the stale entry rather
// than carrying a note about a risk that no longer existed.
const ACCEPTED: Exception[] = [];

// ── The runtime half of the tree ────────────────────────────────────────────

// Node resolution, upwards: a dependency of `node_modules/a/node_modules/b` is
// looked for in that directory's own node_modules first, then each parent's.
function resolveDep(nodes: LockPackages, fromPath: string, name: string): string | null {
  const segments = fromPath === "" ? [] : fromPath.split("/");
  for (let end = segments.length; end >= 0; end--) {
    const prefix = segments.slice(0, end).join("/");
    const candidate = `${prefix === "" ? "" : `${prefix}/`}node_modules/${name}`;
    if (Object.hasOwn(nodes, candidate)) return candidate;
  }
  return null;
}

// Workspaces are `link: true` entries pointing at a directory in the repo; the
// real dependency list lives on that directory's own entry.
function follow(nodes: LockPackages, path: string): string {
  const node = nodes[path];
  if (node?.link === true && typeof node.resolved === "string") return node.resolved;
  return path;
}

// Every node_modules path a shipped process can reach. A pure function of the
// lockfile's `packages` map, which is what lets the fixture below hold it to
// its answer on every run.
export function runtimeReachable(nodes: LockPackages): Set<string> {
  const seen = new Set<string>();
  // Only `dependencies`. The root's devDependencies (turbo, biome, tsc) and
  // each workspace's (vitest, drizzle-kit, playwright) are the whole point of
  // the exercise.
  const queue: Array<[string, string]> = Object.keys(nodes)
    .filter((path) => path === "" || !path.startsWith("node_modules/"))
    .flatMap((path) =>
      Object.keys(nodes[path]?.dependencies ?? {}).map((name): [string, string] => [path, name]),
    );

  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    const [fromPath, name] = next;
    const found = resolveDep(nodes, fromPath, name);
    if (found === null || seen.has(found)) continue;
    seen.add(found);
    const target = follow(nodes, found);
    if (target !== found) seen.add(target);
    const node = nodes[target];
    if (node === undefined) continue;
    for (const dep of [
      ...Object.keys(node.dependencies ?? {}),
      ...Object.keys(node.optionalDependencies ?? {}),
    ]) {
      queue.push([target, dep]);
    }
  }
  return seen;
}

// ── The audit ───────────────────────────────────────────────────────────────

function audit(): AuditReport {
  // Exit code 1 means "found something", which is not a failure of the command.
  let raw: string;
  try {
    raw = execFileSync("npm", ["audit", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // `in` narrows without asserting: execFileSync attaches stdout to the
    // error it throws, and anything else thrown here genuinely has none.
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error ? error.stdout : undefined;
    if (typeof stdout !== "string" || stdout === "") throw error;
    raw = stdout;
  }
  // Annotated rather than asserted — see set-version.ts.
  const parsed: AuditReport = JSON.parse(raw);
  return parsed;
}

// One advisory can be reported against several packages (the vulnerable one and
// everything that depends on it), so collect by GHSA id and remember every
// package and path it was seen at.
export function advisories(report: AuditReport, reachable: Set<string>): Advisory[] {
  const found = new Map<string, Advisory>();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
    const runtime = (entry.nodes ?? []).some((path) => reachable.has(path));
    for (const via of entry.via) {
      if (typeof via === "string") continue; // a re-export of another package's advisory
      const id = via.url?.split("/").pop() ?? via.source?.toString() ?? via.title;
      if (id === undefined) continue;
      const existing = found.get(id);
      if (existing === undefined) {
        found.set(id, {
          id,
          title: via.title ?? id,
          severity: via.severity,
          url: via.url,
          packages: new Set([name]),
          runtime,
        });
        continue;
      }
      existing.packages.add(name);
      existing.runtime ||= runtime;
    }
  }
  return [...found.values()];
}

// ── Both halves, held to their answers on every run ─────────────────────────
//
// The same reason scripts/lint-tailwind.ts checks its own cases: a gate's real
// failure mode is not a wrong answer, it is an empty one. A renamed field in
// either schema above does not throw — it produces no advisories and a green
// build that checked nothing, which is the worst outcome available here. Typing
// the shapes says what we expect; this says we still get it.

// A lockfile in miniature, with one instance of every shape the walk has to
// understand.
const FIXTURE_LOCK: LockPackages = {
  "": { dependencies: { ships: "^1" }, devDependencies: { "build-tool": "^1" } },
  "apps/api": {
    dependencies: { "@repo/contracts": "*", nested: "^1" },
    devDependencies: { vitest: "^1" },
  },
  "packages/contracts": { dependencies: { zod: "^1" }, devDependencies: { "@repo/config": "*" } },
  "packages/config": {},
  "node_modules/@repo/contracts": { link: true, resolved: "packages/contracts" },
  "node_modules/@repo/config": { link: true, resolved: "packages/config" },
  "node_modules/ships": { dependencies: { shared: "^1" }, optionalDependencies: { chosen: "^1" } },
  // Depends back on `ships`: the walk must terminate rather than loop.
  "node_modules/shared": { dependencies: { ships: "^1" } },
  "node_modules/chosen": {},
  "node_modules/zod": {},
  "node_modules/nested": { dependencies: { shared: "^1" } },
  // Shadows the hoisted `shared` for `nested` alone — the upward-resolution rule.
  "node_modules/nested/node_modules/shared": {},
  "node_modules/build-tool": { dependencies: { "only-dev": "^1" } },
  "node_modules/only-dev": {},
  "node_modules/vitest": {},
};

// Everything a container can reach in FIXTURE_LOCK, and nothing else. The
// absences carry as much as the entries: `build-tool` and `vitest` are
// devDependencies, `only-dev` is reachable only through one, and
// `@repo/config` is a workspace that only a devDependency links to.
const FIXTURE_REACHABLE = [
  "node_modules/@repo/contracts",
  "node_modules/chosen",
  "node_modules/nested",
  "node_modules/nested/node_modules/shared",
  "node_modules/shared",
  "node_modules/ships",
  "node_modules/zod",
  "packages/contracts",
];

// An audit report in miniature, in the shape npm states it.
const FIXTURE_REPORT: AuditReport = {
  auditReportVersion: 2,
  vulnerabilities: {
    ships: {
      nodes: ["node_modules/ships"],
      via: [
        {
          source: 1,
          title: "reachable from a shipped process",
          severity: "high",
          url: "https://github.com/advisories/GHSA-aaaa-aaaa-aaaa",
        },
      ],
    },
    // The same advisory, against a second package. It must collapse to one.
    nested: {
      nodes: ["node_modules/nested"],
      via: [
        {
          source: 1,
          title: "reachable from a shipped process",
          severity: "high",
          url: "https://github.com/advisories/GHSA-aaaa-aaaa-aaaa",
        },
      ],
    },
    "build-tool": {
      nodes: ["node_modules/build-tool"],
      via: [
        {
          source: 2,
          title: "never leaves the runner",
          severity: "critical",
          url: "https://github.com/advisories/GHSA-bbbb-bbbb-bbbb",
        },
      ],
    },
    // A string `via` is a re-export of another package's advisory and adds none
    // of its own.
    "only-dev": { nodes: ["node_modules/only-dev"], via: ["build-tool"] },
  },
  metadata: { vulnerabilities: { total: 4 } },
};

function selfCheck(): void {
  const wrong: string[] = [];

  const reachable = [...runtimeReachable(FIXTURE_LOCK)].sort();
  if (reachable.join("\n") !== FIXTURE_REACHABLE.join("\n")) {
    wrong.push(
      `the reachability walk answered:\n    ${reachable.join("\n    ")}\n  expected:\n    ${FIXTURE_REACHABLE.join("\n    ")}`,
    );
  }

  const found = advisories(FIXTURE_REPORT, new Set(FIXTURE_REACHABLE));
  const summary = found
    .map(
      (entry) =>
        `${entry.id} ${entry.severity} runtime=${entry.runtime} ${[...entry.packages].sort().join("+")}`,
    )
    .sort();
  const expected = [
    "GHSA-aaaa-aaaa-aaaa high runtime=true nested+ships",
    "GHSA-bbbb-bbbb-bbbb critical runtime=false build-tool",
  ];
  if (summary.join("\n") !== expected.join("\n")) {
    wrong.push(
      `the audit parse answered:\n    ${summary.join("\n    ")}\n  expected:\n    ${expected.join("\n    ")}`,
    );
  }

  if (wrong.length === 0) return;
  console.error("audit-gate is broken — its own cases do not hold:");
  for (const line of wrong) console.error(`  ${line}`);
  process.exit(2);
}

// The fixture proves the parse is right about a report we wrote. This proves the
// report npm actually handed us is the one the parse was written against: the
// schema is versioned, and a bump that renames `vulnerabilities` would otherwise
// read as a clean tree.
function assertReportIsParsable(report: AuditReport): void {
  if (report.auditReportVersion !== 2) {
    console.error(
      `npm audit --json reported schema version ${report.auditReportVersion ?? "(absent)"}, ` +
        "and this script reads version 2.\n" +
        "  Re-read the report and update the types in scripts/audit-gate.ts before trusting it.",
    );
    process.exit(2);
  }
  const entries = Object.keys(report.vulnerabilities ?? {}).length;
  const total = report.metadata?.vulnerabilities?.total;
  if (total === undefined || entries !== total) {
    console.error(
      `npm audit --json says ${total ?? "(absent)"} vulnerable packages and this script read ${entries}.\n` +
        "  The two disagreeing means the report moved under us — fix the parse rather than the count.",
    );
    process.exit(2);
  }
}

// ── The gate ────────────────────────────────────────────────────────────────

function main(): void {
  selfCheck();

  const lock: { packages?: LockPackages } = JSON.parse(
    readFileSync(resolve(ROOT, "package-lock.json"), "utf8"),
  );
  if (lock.packages === undefined) {
    console.error("package-lock.json has no `packages` map — nothing to walk.");
    process.exit(2);
  }

  const report = audit();
  assertReportIsParsable(report);

  const reachable = runtimeReachable(lock.packages);
  const all = advisories(report, reachable);
  const blocking = all.filter((entry) => BLOCKING.has(entry.severity) && entry.runtime);
  const accepted = new Map(ACCEPTED.map((entry) => [entry.id, entry]));

  const unaccepted = blocking.filter((entry) => !accepted.has(entry.id));
  // An exception for an advisory that no longer appears is worse than no
  // exception: it is a note claiming a risk is being carried when it is not, and
  // the next person reads it as still true. Removing it is the point of failing.
  const stale = ACCEPTED.filter((entry) => !all.some((found) => found.id === entry.id));

  const runtimeCount = all.filter((entry) => entry.runtime).length;
  console.log(
    `${all.length} advisories, ${runtimeCount} reachable from shipped code, ` +
      `${blocking.length} of those high or critical`,
  );
  for (const entry of all.filter((found) => !found.runtime)) {
    console.log(`  build-time only  ${entry.severity.padEnd(8)} ${entry.id}  ${entry.title}`);
  }
  for (const entry of blocking) {
    const note = accepted.get(entry.id);
    const mark = note === undefined ? "BLOCKING" : "accepted";
    console.log(`  ${mark}  ${entry.severity.padEnd(8)} ${entry.id}  ${entry.title}`);
    if (note !== undefined) console.log(`            ${note.why}`);
  }

  if (unaccepted.length === 0 && stale.length === 0) process.exit(0);

  console.error("");
  for (const entry of unaccepted) {
    console.error(
      `${entry.severity} advisory reachable from shipped code: ${entry.id}\n` +
        `  ${entry.title}\n` +
        `  ${entry.url ?? "(no advisory url)"}\n` +
        `  via ${[...entry.packages].join(", ")}\n` +
        `  Fix it, or add it to ACCEPTED in scripts/audit-gate.ts with a reason it cannot be reached.`,
    );
  }
  for (const entry of stale) {
    console.error(
      `${entry.id} (${entry.package}) is accepted in scripts/audit-gate.ts and no longer reported.\n` +
        `  Remove the entry — it was retired by: ${entry.until}`,
    );
  }
  process.exit(1);
}

main();
