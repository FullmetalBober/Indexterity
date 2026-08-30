#!/usr/bin/env node
// A TypeScript file must not contain `as unknown as`.
//
// It is a double assertion, and what it does is not "a stronger cast" — it
// launders the value through `unknown` so the compiler stops comparing the two
// types at all. Every check the single form still performs is lost with it.
//
// The repo carried 37 of them and NONE survived contact with an alternative:
//
//   - 11 were stale. The types had caught up, or never disagreed; deleting the
//     cast compiled unchanged. One had outlived a `@types/mssql` bump by long
//     enough that `encrypt: "strict"` needed nothing at all.
//   - 1 was a constructor overload the types lack. A constructor taking fewer
//     parameters is assignable to a type taking more, so declaring the type and
//     ASSIGNING needed no cast and kept three real checks the double had killed.
//   - 1 was a callback signature the library under-declares. Making the
//     parameter OPTIONAL is assignable to the no-argument type the types want,
//     and is also honest: the undefined case became a thrown sentence.
//   - 1 was a property injected onto `window`. `declare global` says what is
//     true of the runtime; the cast only said to stop asking.
//   - 23 were test fakes. They went through a `stub<T>()` helper first, then
//     through `Partial<T>` (which surfaced 18 real mismatches), and are now
//     gone entirely: every one of those tests writes a COMPLETE implementation
//     of a narrow interface instead. The helper has no callers and is deleted.
//
// So the rule is not aesthetic. Each one was hiding a check that turned out to
// be worth having, and the alternatives were all cheaper than the bug the cast
// would eventually let through.
//
// If a genuinely irreducible case appears — a library whose types are wrong in a
// way no declaration can express — the answer is a narrow shim with a comment
// naming the library, the version, and the runtime behaviour relied on, plus a
// test that proves the behaviour. Then add it below, deliberately, with that
// reasoning attached rather than inline where nobody reviews it again.
//
// Biome has no rule for this, which is why it is a check of its own.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = ["apps", "packages", "scripts", "deploy"];
const EXTENSIONS = [".ts", ".tsx"];
const SKIP = new Set(["node_modules", ".git", "dist", ".output", ".turbo", "graphify-out"]);

// Generated files. `routeTree.gen.ts` is written by TanStack Router's plugin and
// carries fifteen `as any` that regenerate on every build — a rule nobody can
// obey is a rule people learn to disable.
const GENERATED = /\.gen\.tsx?$/;

// Files allowed to say it, and why. **Empty**, and it has stayed empty through
// the one case that looked irreducible.
//
// Drizzle's `execute` returns `PgRaw<…>` and `select()` a `PgSelectBuilder` —
// classes with phantom generics, not promises — so a fake resolving to
// `{ rows }`, which is what every caller awaits, is assignable to neither and
// does not overlap enough for even a single assertion. Seven test files needed
// it, and the first answer was two helpers here with the double assertion
// contained and this file allowlisted.
//
// That was treating the symptom. Nothing wanted a whole `Database`: the dial
// budget and the tick wanted rows, and the dispatcher wanted a list of cluster
// ids. `DatabaseService.rows()` and `ClusterRoster` say so, and both are
// ordinary types a fake can satisfy. The allowlist emptied itself.
//
// An entry here is a decision, not a suppression: it has to arrive with the
// library, the version, the runtime behaviour relied on, and a test proving it —
// and the case above is a reminder to look for the seam first.
const ALLOWED = new Set<string>([]);

// This file, which quotes the form in order to ban it. Kept apart from ALLOWED
// so that list stays a record of real exceptions rather than of bookkeeping.
const SELF = "scripts/lint-assertions.ts";

// Three shapes, each a claim the compiler cannot check and the runtime does not
// keep. Deliberately NOT "every `as`": narrowing a caught `unknown` to an Error,
// or a readonly array to a mutable one for a driver, is a statement about
// something already true. These three are not.
const BANNED = [
  {
    // The double assertion. Launders through `unknown` so the compiler stops
    // comparing the two types at all.
    pattern: /\bas\s+unknown\s+as\b/,
    name: "as unknown as",
  },
  {
    // `as any` gives up more than the double assertion does: it disables
    // checking of everything the value touches from there on.
    pattern: /\bas\s+any\b/,
    name: "as any",
  },
  {
    // `{} as T`. The purest form: nothing is implemented, and every member
    // answers `undefined` to the first thing that asks for it.
    //
    // `[] as T[]` is deliberately NOT here. An empty array IS an empty array of
    // any element type, so that assertion states something true — the rule is
    // about claims the runtime does not keep, not about the `as` keyword.
    pattern: /\{\s*\}\s+as\s+[A-Za-z_$]/,
    name: "an empty object asserted to a type",
  },
];

function sourceFiles(): string[] {
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

function main(): void {
  const files = sourceFiles();
  let found = 0;
  for (const path of files) {
    const rel = relative(ROOT, path);
    if (rel === SELF || ALLOWED.has(rel) || GENERATED.test(rel)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      // The rule's own explanation, and this file's, are prose about the form
      // rather than uses of it.
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
      const hit = BANNED.find((banned) => banned.pattern.test(line));
      if (hit === undefined) continue;
      found += 1;
      console.error(`${rel}:${index + 1}: [${hit.name}] ${line.trim()}`);
    }
  }
  if (found > 0) {
    console.error(
      `\n${found} type assertion${found === 1 ? "" : "s"} the compiler cannot check.\n` +
        "Each is a claim the compiler cannot check and the runtime does not keep.\n" +
        "Try, in order: delete it (the types may have caught up); declare and ASSIGN rather\n" +
        "than assert; widen your own signature (an optional parameter is assignable to a\n" +
        "no-argument type); `declare global` for something the runtime really adds; or\n" +
        "name a narrow interface, so the test's object implements ALL of it and fakes\n" +
        "nothing at all.\n" +
        "See scripts/lint-assertions.ts for what each of the repo's 37 turned out to be.",
    );
    process.exit(1);
  }
  console.log(`lint-assertions: ${files.length} TypeScript files, no unchecked assertions`);
}

main();
