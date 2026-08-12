// Delete `devDependencies` from every manifest in a pruned workspace, so that a
// following `npm install` cannot resolve them.
//
// This exists because `--omit=dev` does not work here, which took measuring to
// believe. `turbo prune --docker` regenerates the lockfile for the subset it kept,
// and the regenerated one carries no `dev: true` markers — so npm sees the whole
// graph as production and installs it whatever the flag says. Measured on the api
// image: `npm install --omit=dev` and install-then-`npm prune --omit=dev` both
// produce the same 284 MB tree, typescript and drizzle-kit included, for 5 MB of
// application code.
//
// So the manifests are the lever rather than the flag: npm cannot install what
// nothing asks for. Run in a stage that only serves runtime dependencies — never
// before a build, which needs exactly the packages this removes.
//
// `.mts` rather than `.ts`: node decides a `.ts` file's module format from the
// nearest package.json, and this is copied to /tmp — deliberately outside the tree
// the runtime image is built from, so it does not ship — where there is none. The
// explicit extension is what makes it an ES module wherever it is put. Types are
// stripped by node on the way in, and typechecked by tsconfig.scripts.json like
// every other hand-written script here.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function manifests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return manifests(path);
    return entry.name === "package.json" ? [path] : [];
  });
}

const root = process.argv[2] ?? ".";
let stripped = 0;
for (const path of manifests(root)) {
  const manifest: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
  const dev = manifest.devDependencies;
  if (dev === undefined || typeof dev !== "object" || dev === null) continue;
  const names = Object.keys(dev);
  delete manifest.devDependencies;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${path}: dropped ${names.length} devDependencies`);
  stripped += 1;
}
console.log(`prod-manifests: rewrote ${stripped} manifest(s)`);
