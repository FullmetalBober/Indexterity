import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

// Stage the built api where no node_modules can reach it, once per run.
//
// The images ship the bundles and no node_modules (D182). Run from dist/, a
// bundle that still needs a package at run time finds the repository's
// node_modules right above it, boots, and passes this suite; the same bundle in
// an image dies at boot with MODULE_NOT_FOUND. Run from a copy outside the
// repository, it fails here first, on every pull request, instead of in the
// chart's Kind install that only packaging changes reach.
//
// Staged are the two entrypoints this suite spawns, and the two files they read
// from disk: package.json (version.ts) and drizzle/ (the migrator). rotate-key.js
// and set-plan.js are not: measured, every package they bundle is one main.js
// bundles too, and migrate.js adds only drizzle's migrator.
const API = path.resolve(__dirname, "..");
const SPAWNED = ["main.js", "migrate.js"];

declare module "vitest" {
  export interface ProvidedContext {
    // The staged copy's root, or "" when there was no build to stage.
    builtApi: string;
  }
}

export default function stageBuiltApi(project: TestProject): (() => void) | undefined {
  if (!existsSync(path.join(API, "dist", "main.js"))) {
    // Not an error here: the adapter-level files (mssql, postgres) spawn
    // nothing, and their CI jobs build only the api's dependencies. builtEntry
    // names the missing build to whichever file needs one.
    project.provide("builtApi", "");
    return undefined;
  }
  const root = mkdtempSync(path.join(tmpdir(), "indexterity-api-"));
  const above = nodeModulesAbove(root);
  if (above) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `${above} is above ${tmpdir()}, so it would resolve what the images cannot — point TMPDIR somewhere without one`,
    );
  }
  for (const entry of SPAWNED) {
    cpSync(path.join(API, "dist", entry), path.join(root, "dist", entry));
  }
  cpSync(path.join(API, "package.json"), path.join(root, "package.json"));
  cpSync(path.join(API, "drizzle"), path.join(root, "drizzle"), { recursive: true });
  project.provide("builtApi", root);
  return () => rmSync(root, { recursive: true, force: true });
}

function nodeModulesAbove(dir: string): string | undefined {
  for (let at = dir; ; at = path.dirname(at)) {
    const candidate = path.join(at, "node_modules");
    if (existsSync(candidate)) return candidate;
    if (at === path.dirname(at)) return undefined;
  }
}
