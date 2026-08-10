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
const BLOCKING = new Set(["high", "critical"]);

// Advisories we have looked at and are carrying on purpose.
//
// Empty, and that is the intended resting state rather than a sign nobody has
// filled it in. An entry here is a high or critical advisory that a container
// runs and that we are shipping anyway, which should be rare enough to argue
// about each time.
//
// The shape, when one is needed:
//
//   {
//     id: "GHSA-xxxx-xxxx-xxxx",   // the advisory, NOT the package
//     package: "find-my-way",      // for the message only
//     why: "one line, the reason it cannot be reached from this deployment",
//     until: "the condition that ends it, in words",
//   }
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
const ACCEPTED = [];

// ── The runtime half of the tree ────────────────────────────────────────────

const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
const nodes = lock.packages;

// Node resolution, upwards: a dependency of `node_modules/a/node_modules/b` is
// looked for in that directory's own node_modules first, then each parent's.
function resolveDep(fromPath, name) {
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
function follow(path) {
  const node = nodes[path];
  if (node?.link === true && typeof node.resolved === "string") return node.resolved;
  return path;
}

function runtimeReachable() {
  const seen = new Set();
  // Only `dependencies`. The root's devDependencies (turbo, biome, tsc) and
  // each workspace's (vitest, drizzle-kit, playwright) are the whole point of
  // the exercise.
  const queue = Object.keys(nodes)
    .filter((path) => path === "" || !path.startsWith("node_modules/"))
    .flatMap((path) => Object.keys(nodes[path].dependencies ?? {}).map((name) => [path, name]));

  while (queue.length > 0) {
    const [fromPath, name] = queue.pop();
    const found = resolveDep(fromPath, name);
    if (found === null || seen.has(found)) continue;
    seen.add(found);
    const target = follow(found);
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

function audit() {
  // Exit code 1 means "found something", which is not a failure of the command.
  let raw;
  try {
    raw = execFileSync("npm", ["audit", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error.stdout !== "string" || error.stdout === "") throw error;
    raw = error.stdout;
  }
  return JSON.parse(raw);
}

// One advisory can be reported against several packages (the vulnerable one and
// everything that depends on it), so collect by GHSA id and remember every
// package and path it was seen at.
function advisories(report, reachable) {
  const found = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
    const runtime = (entry.nodes ?? []).some((path) => reachable.has(path));
    for (const via of entry.via) {
      if (typeof via === "string") continue; // a re-export of another package's advisory
      const id = via.url?.split("/").pop() ?? via.source?.toString() ?? via.title;
      const existing = found.get(id);
      if (existing === undefined) {
        found.set(id, {
          id,
          title: via.title,
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

const reachable = runtimeReachable();
const all = advisories(audit(), reachable);
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
      `  ${entry.url}\n` +
      `  via ${[...entry.packages].join(", ")}\n` +
      `  Fix it, or add it to ACCEPTED in scripts/audit-gate.mjs with a reason it cannot be reached.`,
  );
}
for (const entry of stale) {
  console.error(
    `${entry.id} (${entry.package}) is accepted in scripts/audit-gate.mjs and no longer reported.\n` +
      `  Remove the entry — it was retired by: ${entry.until}`,
  );
}
process.exit(1);
