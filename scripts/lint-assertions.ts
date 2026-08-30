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
//   - 23 were test fakes, now `stub<T>()` (apps/api/src/test-utils.ts), which
//     checks the member NAMES against the real type — so a renamed method stops
//     compiling instead of leaving every fake asserting against a shape nothing
//     has any more.
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

// Files allowed to say it, and why. One entry, and it is the shape the rule
// anticipates: a library whose types cannot express what it does.
//
// apps/api/src/test-utils.ts holds two drizzle helpers. `execute` is declared to
// return `PgRaw<…>` and `select()` a `PgSelectBuilder` — classes with phantom
// generics, not promises — so a fake resolving to `{ rows }`, which is what
// every caller awaits, is assignable to neither and does not overlap enough for
// even a single assertion. Seven test files needed it. Putting it behind two
// named helpers in one file makes it one reviewed decision instead of seven
// unexamined ones, and the comment there carries the justification.
//
// The real fix is a seam: nothing wants a whole `Database`, only "give me these
// rows", and a narrow interface would be honestly fakeable. That is a production
// change and is why this entry is expected to be temporary.
const ALLOWED = new Set<string>(["apps/api/src/test-utils.ts"]);

// This file, which quotes the form in order to ban it. Kept apart from ALLOWED
// so that list stays a record of real exceptions rather than of bookkeeping.
const SELF = "scripts/lint-assertions.ts";

const PATTERN = /\bas\s+unknown\s+as\b/;

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
    if (rel === SELF || ALLOWED.has(rel)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      // The rule's own explanation, and this file's, are prose about the form
      // rather than uses of it.
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
      if (!PATTERN.test(line)) continue;
      found += 1;
      console.error(`${rel}:${index + 1}: ${line.trim()}`);
    }
  }
  if (found > 0) {
    console.error(
      `\n${found} double assertion${found === 1 ? "" : "s"} (\`as unknown as\`).\n` +
        "It launders the value through `unknown`, so the compiler stops checking entirely.\n" +
        "Try, in order: delete it (the types may have caught up); declare and ASSIGN rather\n" +
        "than assert; widen your own signature (an optional parameter is assignable to a\n" +
        "no-argument type); `declare global` for something the runtime really adds; or\n" +
        "`stub<T>()` from apps/api/src/test-utils.ts for a test fake.\n" +
        "See scripts/lint-assertions.ts for what each of the repo's 37 turned out to be.",
    );
    process.exit(1);
  }
  console.log(`lint-assertions: ${files.length} TypeScript files, no double assertions`);
}

main();
