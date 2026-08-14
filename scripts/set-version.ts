#!/usr/bin/env node
// One version for the whole product, written everywhere it is stated.
//
//   npm run version:set 0.2.0     # write it
//   npm run version:check         # assert every file agrees
//
// The root package.json is the source of truth. The workspaces are private and
// never published to npm, but a version that disagrees with the release is a
// lie in a file people read, so they follow. The chart carries it twice:
// `version` is the chart's own, `appVersion` is the images it deploys, and for
// a chart that only ever ships this app they are the same number.
//
// The release workflow takes the version from the git tag and asserts it
// matches what is committed here, so a tag cannot claim a version the tree does
// not have.
//
// `package-lock.json` is one of the files, and was not for three releases (#186).
// npm records a workspace's version there too, so a bump that skipped it left a
// tree `npm ci` REFUSES while `version:check` reported success — the one command
// whose whole job is reporting version drift, silent about the drift that stops
// the build. 0.3.0, 0.4.0 and 0.5.0 each fixed it by hand with
// `npm install --package-lock-only`.
//
// Written directly rather than by shelling out to that command, for three
// reasons: it cannot re-resolve a transitive dependency as a side effect of a
// version bump, it needs no registry and so no warm cache (a release should not
// depend on the network to renumber itself), and `set` and `check` then read the
// same list of places and cannot drift apart. That is only safe because npm's
// own formatting is exactly `JSON.stringify(lock, null, 2)` plus a newline —
// verified byte-for-byte on the committed lockfile — so a round trip through
// here changes the version lines and nothing else.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  "package.json",
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/config/package.json",
  "packages/contracts/package.json",
  "packages/errors/package.json",
  "packages/metrics/package.json",
];
const CHART = "deploy/helm/indexterity/Chart.yaml";
const LOCKFILE = "package-lock.json";

// Semver, optionally with a prerelease — enough to reject a typo without
// reimplementing the spec.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// The one field this script reads, plus everything else it must write back
// untouched. `version` is optional because a package.json that has lost it is
// exactly the state `check` exists to report, not to crash on.
type PackageJson = { version?: string } & Record<string, unknown>;

function readJson(rel: string): PackageJson {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as PackageJson;
}

function writeJson(rel: string, value: object): void {
  writeFileSync(join(ROOT, rel), `${JSON.stringify(value, null, 2)}\n`);
}

// The lockfile, as far as this file is concerned: a version at the document root
// and one per entry in `packages`, keyed by directory.
type LockEntry = { version?: string } & Record<string, unknown>;
type Lockfile = {
  lockfileVersion: number;
  version?: string;
  packages: Record<string, LockEntry>;
} & Record<string, unknown>;

// Where the lockfile states the version of the manifest at `rel`: a workspace is
// keyed by its directory, the root by the empty string.
//
// The root's version is stated TWICE — once as `packages[""]` and once at the
// document root — and `node_modules/@repo/*` states it not at all, those being
// links carrying a `resolved` path instead. Eight fields between them, which is
// why renumbering shows up as a 16-line lockfile diff.
function lockKey(rel: string): string {
  return rel === "package.json" ? "" : dirname(rel);
}

function readLockfile(): Lockfile {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, LOCKFILE), "utf8"));
  const lock = raw as Lockfile;
  // Refuse a shape this does not recognise rather than quietly touch nothing in
  // it. Updating no fields and reporting success is the exact failure #186 was,
  // and a lockfileVersion bump is the likeliest way to reintroduce it.
  if (lock.lockfileVersion !== 3) {
    console.error(
      `${LOCKFILE} is lockfileVersion ${JSON.stringify(lock.lockfileVersion)}, and this ` +
        "script knows 3. Check where npm records workspace versions now, then update lockKey().",
    );
    process.exit(1);
  }
  if (typeof lock.packages !== "object" || lock.packages === null) {
    console.error(`${LOCKFILE} has no "packages" map, so there is nothing to renumber in it`);
    process.exit(1);
  }
  return lock;
}

type ChartVersions = { text: string; version?: string; appVersion?: string };

function chartVersions(): ChartVersions {
  const text = readFileSync(join(ROOT, CHART), "utf8");
  return {
    text,
    version: /^version: (.+)$/m.exec(text)?.[1]?.trim(),
    appVersion: /^appVersion: "?([^"\n]+)"?$/m.exec(text)?.[1]?.trim(),
  };
}

function set(version: string): void {
  if (!SEMVER.test(version)) {
    console.error(`not a version: ${version} (expected e.g. 0.2.0)`);
    process.exit(1);
  }
  // Everything that can refuse, before anything is written. A run that renumbers
  // the manifests and then bails on the lockfile leaves precisely the tree #186
  // is about — and leaves it behind a non-zero exit, which reads as "nothing
  // happened". So the lockfile is read and its entries are resolved up front, and
  // the writes below cannot fail partway for a reason this could have known.
  const lock = readLockfile();
  const entries: LockEntry[] = [];
  for (const rel of PACKAGES) {
    const key = lockKey(rel);
    const entry = lock.packages[key];
    // A manifest with no lockfile entry means the two have drifted about which
    // workspaces exist, and renumbering the rest would hide that.
    if (entry === undefined) {
      console.error(`${LOCKFILE} has no packages entry for ${JSON.stringify(key)} (${rel})`);
      console.error("run npm install first, so the lockfile knows about every workspace");
      process.exit(1);
    }
    entries.push(entry);
  }

  for (const rel of PACKAGES) {
    const pkg = readJson(rel);
    pkg.version = version;
    writeJson(rel, pkg);
  }
  const { text } = chartVersions();
  writeFileSync(
    join(ROOT, CHART),
    text
      .replace(/^version: .+$/m, `version: ${version}`)
      .replace(/^appVersion: .+$/m, `appVersion: "${version}"`),
  );
  lock.version = version;
  for (const entry of entries) entry.version = version;
  writeJson(LOCKFILE, lock);

  console.log(
    `${version} written to ${PACKAGES.length} package.json files, the chart and ${LOCKFILE}`,
  );
  // Deliberately not `git commit -am`: the tree here is shared with whatever else
  // is in progress, and a release is the worst commit to widen by accident.
  console.log(
    `next: review the diff (${PACKAGES.length + 2} files), commit them, ` +
      `then git tag v${version} && git push --tags`,
  );
}

function check(expected?: string): void {
  const root = readJson("package.json").version;
  const want = expected ?? root;
  // The source of truth having no version at all is its own failure, and one
  // worth naming: without this every file below would be reported as wrong
  // against `undefined`.
  if (want === undefined) {
    console.error("package.json has no version field, so there is nothing to check against");
    process.exit(1);
  }
  const wrong: string[] = [];
  for (const rel of PACKAGES) {
    const found = readJson(rel).version;
    if (found !== want) wrong.push(`${rel}: ${found ?? "(no version field)"}`);
  }
  const chart = chartVersions();
  if (chart.version !== want) wrong.push(`${CHART} version: ${chart.version ?? "(not found)"}`);
  if (chart.appVersion !== want) {
    wrong.push(`${CHART} appVersion: ${chart.appVersion ?? "(not found)"}`);
  }
  // The lockfile too, and this is the half that earns its keep: it turns an
  // `npm ci` refusal further down the pipeline — reported as a lockfile mismatch,
  // which names nothing about releases — into a failure here, where the version
  // was set. `release.yml` calls this against the tag before it builds anything
  // and before any install, so it is also what stops a tag being published
  // against a lockfile that still says the old number.
  const lock = readLockfile();
  if (lock.version !== want) wrong.push(`${LOCKFILE} version: ${lock.version ?? "(not found)"}`);
  for (const rel of PACKAGES) {
    const key = lockKey(rel);
    const label = `${LOCKFILE} packages[${JSON.stringify(key)}]`;
    const entry = lock.packages[key];
    if (entry === undefined) wrong.push(`${label}: (no entry — run npm install)`);
    else if (entry.version !== want) wrong.push(`${label}: ${entry.version ?? "(no version)"}`);
  }
  if (wrong.length > 0) {
    console.error(`expected ${want} everywhere, found:\n  ${wrong.join("\n  ")}`);
    console.error(`fix with: npm run version:set ${want}`);
    process.exit(1);
  }
  console.log(
    `version ${want} agrees across ${PACKAGES.length} packages, the chart and ${LOCKFILE}`,
  );
}

const [command, value] = process.argv.slice(2);
if (command === "set") set(value ?? "");
else if (command === "check") check(value);
else {
  console.error("usage: set-version.ts set <version> | check [expected]");
  process.exit(1);
}
