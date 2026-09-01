// Walk the repo for source files, for the lint scripts that check text rather
// than types.
//
// Extracted because two of them held the same fourteen lines and a copy-paste
// detector found it. The shared part is deliberately small — a recursive walk
// with a skip set — because that IS all they agree on: each caller brings its
// own roots and extensions, and `lint-tailwind` and `lint-gopls` keep their own
// walks because theirs answer different questions (one yields, one filters on a
// directory rule of its own).
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories no source-text rule has an opinion about. */
export const SKIP = new Set(["node_modules", ".git", "dist", ".output", ".turbo", "graphify-out"]);

export function sourceFiles(roots: readonly string[], extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(path);
    }
  };
  for (const root of roots) walk(join(ROOT, root));
  return out;
}
