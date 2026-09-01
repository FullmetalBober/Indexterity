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
// `--build-only <name>` drops that package's `dependencies` as well, and is a
// narrower claim than it looks: not "these are dev dependencies" — they are not,
// and the manifest is right to list them — but "this package resolves nothing from
// node_modules in THIS image". Exactly one package qualifies today. The all-in-one
// starts the dashboard from `apps/web/.output`, a nitro bundle that is
// self-contained (apps/web/Dockerfile's runtime stage copies `.output` and no
// node_modules at all, which is the proof), so @repo/web's production tree was
// 185 MB installed for nothing: `@tanstack/react-start` is the framework and
// correctly a dependency, but build-time here, and it drags in
// @tanstack/start-plugin-core — `dev: false`, so --omit=dev keeps it — and under
// that two prebuilt lightningcss bindings, gnu and musl, 9.6 MB each, one of which
// can never load whatever the base is. #182.
//
// A name that matches no manifest is an error rather than a no-op, because the
// failure is otherwise silent: rename a workspace package and the image quietly
// gains back the tree this was written to remove.
//
// `.mts` rather than `.ts`: node decides a `.ts` file's module format from the
// nearest package.json, and this is copied to /tmp — deliberately outside the tree
// the runtime image is built from, so it does not ship — where there is none. The
// explicit extension is what makes it an ES module wherever it is put. Types are
// stripped by node on the way in, and typechecked by the root tsconfig.json like
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

function fail(message: string): never {
  console.error(`prod-manifests: ${message}`);
  process.exit(1);
}

const buildOnly = new Set<string>();
const positional: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === undefined) continue;
  if (arg.startsWith("--build-only=")) {
    buildOnly.add(arg.slice("--build-only=".length));
    continue;
  }
  if (arg === "--build-only") {
    const name = args[i + 1];
    if (name === undefined || name.startsWith("--")) fail("--build-only needs a package name");
    buildOnly.add(name);
    i += 1;
    continue;
  }
  if (arg.startsWith("--")) fail(`unknown option ${arg}`);
  positional.push(arg);
}
const root = positional[0] ?? ".";

const found = new Set<string>();
let stripped = 0;
for (const path of manifests(root)) {
  // `JSON.parse` is `any`, so the `Record<string, unknown>` this carried checked
  // nothing — it is the same claim an assertion makes, and this file rewrites
  // every manifest in the tree, so a file that is not an object at all should
  // stop it rather than be silently written back.
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  const manifest: Record<string, unknown> = { ...parsed };
  const name = manifest.name;
  if (typeof name === "string") found.add(name);

  // Order matters only for the log line, which reads as the manifest does.
  const fields =
    typeof name === "string" && buildOnly.has(name)
      ? ["dependencies", "devDependencies"]
      : ["devDependencies"];

  const dropped: string[] = [];
  for (const field of fields) {
    const value = manifest[field];
    if (value === undefined || typeof value !== "object" || value === null) continue;
    dropped.push(`${Object.keys(value).length} ${field}`);
    delete manifest[field];
  }
  if (dropped.length === 0) continue;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${path}: dropped ${dropped.join(", ")}`);
  stripped += 1;
}

const missing = [...buildOnly].filter((name) => !found.has(name));
if (missing.length > 0)
  fail(`--build-only matched no package under ${root}: ${missing.join(", ")}`);
console.log(`prod-manifests: rewrote ${stripped} manifest(s)`);
