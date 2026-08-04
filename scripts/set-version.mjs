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
  "packages/metrics/package.json",
];
const CHART = "deploy/helm/indexterity/Chart.yaml";

// Semver, optionally with a prerelease — enough to reject a typo without
// reimplementing the spec.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function writeJson(rel, value) {
  writeFileSync(join(ROOT, rel), `${JSON.stringify(value, null, 2)}\n`);
}

function chartVersions() {
  const text = readFileSync(join(ROOT, CHART), "utf8");
  return {
    text,
    version: /^version: (.+)$/m.exec(text)?.[1]?.trim(),
    appVersion: /^appVersion: "?([^"\n]+)"?$/m.exec(text)?.[1]?.trim(),
  };
}

function set(version) {
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

function check(expected) {
  const root = readJson("package.json").version;
  const want = expected ?? root;
  const wrong = [];
  for (const rel of PACKAGES) {
    const found = readJson(rel).version;
    if (found !== want) wrong.push(`${rel}: ${found}`);
  }
  const chart = chartVersions();
  if (chart.version !== want) wrong.push(`${CHART} version: ${chart.version}`);
  if (chart.appVersion !== want) wrong.push(`${CHART} appVersion: ${chart.appVersion}`);
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
  console.error("usage: set-version.mjs set <version> | check [expected]");
  process.exit(1);
}
