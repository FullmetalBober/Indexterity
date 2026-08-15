#!/usr/bin/env node
// A source file must not contain a raw NUL byte.
//
// Two files in this repo did, and both were meant to hold the two-character
// escape (a backslash, then u0000) — the NUL-separated composite keys in
// recommendations.controller.ts and the shape key in mssql/workload.ts. An
// editor that resolves that escape while WRITING the file turns it into a
// literal NUL, and the code carries on working perfectly: a NUL is a legal
// character in a JavaScript string, so joining on the byte and joining on the
// escape produce the identical value, and every test passes.
//
// What breaks is everything that reads the file as TEXT. `file` reports it as
// `data`; grep and ripgrep classify it as binary and SILENTLY skip it, so
// mssql/workload.ts — 480 lines, the whole Query Store plan parser — returned
// nothing for any search, including `grep "export "`. A file that no code search
// can see is a file nobody will maintain, and the way you find out is by
// grepping for something you know is there and being told it is not.
//
// Biome does not object (both files passed `biome check` for their whole life),
// which is why this is a check of its own rather than a rule setting.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Everything a human edits. Deliberately not the whole tree: lockfiles, images
// and build output are not source, and one of them legitimately holding a NUL
// would turn this into a check people learn to ignore.
const ROOTS = ["apps", "packages", "scripts", "deploy", "docs"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yaml", ".yml", ".tpl", ".sql"];
const SKIP = new Set(["node_modules", ".git", "dist", ".output", ".turbo", "graphify-out"]);

async function sourceFiles(): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) out.push(path);
    }
  };
  for (const root of ROOTS) walk(join(ROOT, root));
  return out;
}

// 1-indexed, so the message points where an editor does.
export function nulLines(contents: Buffer): number[] {
  const lines: number[] = [];
  let line = 1;
  for (const byte of contents) {
    if (byte === 0x0a) line += 1;
    else if (byte === 0x00 && lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines;
}

async function main(): Promise<void> {
  const files = await sourceFiles();
  let found = 0;
  for (const path of files) {
    const lines = nulLines(readFileSync(path));
    if (lines.length === 0) continue;
    found += 1;
    console.error(
      `${relative(ROOT, path)}: NUL byte on line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}`,
    );
  }
  if (found > 0) {
    console.error(
      `\n${found} source file${found === 1 ? " contains" : "s contain"} a raw NUL byte.\n` +
        "grep and ripgrep treat those files as binary and skip them without saying so.\n" +
        "Write the two-character escape `\\u0000` instead — the string value is identical.",
    );
    process.exit(1);
  }
  console.log(`lint-source-bytes: ${files.length} source files, no raw NUL bytes`);
}

main();
