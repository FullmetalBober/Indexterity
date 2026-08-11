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

function writeJson(rel: string, value: PackageJson): void {
  writeFileSync(join(ROOT, rel), `${JSON.stringify(value, null, 2)}\n`);
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
  console.log(`${version} written to ${PACKAGES.length} package.json files and the chart`);
  console.log(
    `next: git commit -am "Release ${version}" && git tag v${version} && git push --tags`,
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
  if (wrong.length > 0) {
    console.error(`expected ${want} everywhere, found:\n  ${wrong.join("\n  ")}`);
    console.error(`fix with: npm run version:set ${want}`);
    process.exit(1);
  }
  console.log(`version ${want} agrees across ${PACKAGES.length} packages and the chart`);
}

const [command, value] = process.argv.slice(2);
if (command === "set") set(value ?? "");
else if (command === "check") check(value);
else {
  console.error("usage: set-version.ts set <version> | check [expected]");
  process.exit(1);
}
