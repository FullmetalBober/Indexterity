#!/usr/bin/env node
// A file that exists twice on purpose must be byte-identical to its twin.
//
// The repo has exactly one such pair, and it earned its place: `at` and
// `present` are needed by both apps, and neither can import them from a package
// because every internal package resolves `"types"` to `./src/index.ts` and
// `"default"` to `./dist/index.js` — so a typecheck passes with no build and the
// runtime does not, and the mssql and postgres integration jobs run `npm ci` and
// the suite with no build between them (four went red the day it was shared).
// Thirty duplicated lines of pure function are cheaper than a build step in
// every job that touches them.
//
// What was NOT paid for is drift, and drift had already happened. Both copies
// opened with a comment stating they held the same thirty lines. They did not:
// the api's had grown `keysOf`, the dashboard's had grown `field`, and the
// comment asserting otherwise was the only thing watching. So the claim is
// enforced here instead of stated there.
//
// Byte-identity rather than an AST comparison of shared function names, which
// was the other candidate. It is a stricter rule and a simpler one, and the
// strictness is the point: anything that belongs to only one app belongs BESIDE
// ITS CALLER, not in a file whose whole justification is that both sides need
// every line of it. The api's own narrowing helpers are in
// apps/api/src/errors/message.ts and the dashboard's in apps/web/src/lib/narrow.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./source-files.ts";

// Each entry is a set of paths whose contents must match exactly, and the reason
// the duplication is allowed to exist at all. A new entry is a decision: prefer
// one copy and an import every single time it is possible.
const TWINS: readonly { readonly why: string; readonly paths: readonly string[] }[] = [
  {
    why: "`at` and `present`: both apps need them and neither can import them (see either file's header)",
    paths: ["apps/api/src/errors/at.ts", "apps/web/src/lib/at.ts"],
  },
];

function main(): void {
  let failed = false;

  for (const twin of TWINS) {
    const [first, ...rest] = twin.paths;
    if (first === undefined) continue;
    const reference = readFileSync(join(ROOT, first), "utf8");

    for (const path of rest) {
      const contents = readFileSync(join(ROOT, path), "utf8");
      if (contents === reference) continue;
      failed = true;
      console.error(`${path}: has drifted from ${first}`);
      console.error(`  ${twin.why}`);

      // Which lines, because "these files differ" is not something anybody can
      // act on in a fifty-line file.
      const left = reference.split("\n");
      const right = contents.split("\n");
      for (let line = 0; line < Math.max(left.length, right.length); line += 1) {
        if (left[line] === right[line]) continue;
        console.error(`  first difference at line ${line + 1}:`);
        console.error(`    ${first}: ${left[line] ?? "(end of file)"}`);
        console.error(`    ${path}: ${right[line] ?? "(end of file)"}`);
        break;
      }
    }
  }

  if (failed) {
    console.error(
      "\nCopy one over the other, or — better — move whatever differs beside its own\n" +
        "caller. A twin is justified only while both sides need every line of it.",
    );
    process.exit(1);
  }
  const files = TWINS.reduce((total, twin) => total + twin.paths.length, 0);
  console.log(`lint-twins: ${files} files in ${TWINS.length} twin set, identical.`);
}

main();
