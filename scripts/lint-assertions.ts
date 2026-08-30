#!/usr/bin/env node
// A TypeScript file must not contain an assertion the compiler cannot check.
//
// PARSED, not grepped. The first version matched text, and text cannot tell a
// type assertion from `select id::text as id`, from `it("reads a restart as no
// evidence")`, or from the word "as" in a comment — this repo has hundreds of
// all three. Asked how many assertions were left, the honest answer was "I
// cannot count them with a regex", which is a bad property for the thing that
// enforces the rule. So it walks the AST and looks at `AsExpression` nodes.
//
// The banned kinds, and what each gives up:
//
//   as unknown as   launders through `unknown`, so the compiler stops comparing
//                   the two types at all
//   as any          gives up checking of everything the value touches after it
//   {} as T         nothing is implemented; every member answers `undefined`
//   [] as T         the same, and also UNNECESSARY — `[]` is `never[]`, already
//                   assignable to `T[]`, so these delete rather than move
//   x as Error      `catch` gives `unknown` BECAUSE anything can be thrown; this
//                   reads `.message` off a thrown string and prints "undefined"
//
// Everything else is reported as a COUNT rather than an error. `as const` is a
// literal narrowing, not a claim about a value's shape; narrowing a checked
// `unknown` is a statement about something already true. The count is there so
// the number is known rather than assumed — which is how the five above were
// found in the first place.
//
// The repo carried 37 double assertions and 30 test fakes when this started.
// None survived contact with an alternative: 11 were stale, 1 was a constructor
// overload the types lack, 1 a callback signature we could widen ourselves, 1 a
// `declare global`, and 23 were fakes of dependencies that were simply too wide.
// That is the rule's real argument — a cast you cannot remove is usually a
// design problem, not a type problem.
//
// Replacements live where they are needed: `messageOf` (errors/message.ts),
// `at` and `present` (errors/at.ts, web lib/at.ts).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = ["apps", "packages", "scripts"];
const EXTENSIONS = [".ts", ".tsx"];
const SKIP = new Set(["node_modules", ".git", "dist", ".output", ".turbo", "graphify-out"]);

// Generated files. `routeTree.gen.ts` is written by TanStack Router's plugin and
// carries fifteen `as any` that regenerate on every build — a rule nobody can
// obey is a rule people learn to disable.
const GENERATED = /\.gen\.tsx?$/;

// Files allowed to hold one anyway. EMPTY, and it has stayed empty through
// every case that looked irreducible — see the note above.
const ALLOWED = new Set<string>([]);

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly text: string;
}

function isEmptyLiteral(node: ts.Node): boolean {
  if (ts.isObjectLiteralExpression(node)) return node.properties.length === 0;
  if (ts.isArrayLiteralExpression(node)) return node.elements.length === 0;
  return false;
}

/** The banned kind this assertion is, or null when it is one we allow. */
function classify(node: ts.AsExpression): string | null {
  const type = node.type;
  // `as const` — a literal narrowing rather than a claim.
  if (ts.isTypeReferenceNode(type) && type.typeName.getText() === "const") return null;
  if (type.kind === ts.SyntaxKind.AnyKeyword) return "as any";
  // The double assertion: an inner `as unknown` feeding an outer assertion.
  const inner = node.expression;
  if (
    ts.isAsExpression(inner) &&
    inner.type.kind === ts.SyntaxKind.UnknownKeyword &&
    type.kind !== ts.SyntaxKind.UnknownKeyword
  ) {
    return "as unknown as";
  }
  if (isEmptyLiteral(inner)) return "an empty literal asserted to a type";
  if (ts.isTypeReferenceNode(type) && type.typeName.getText() === "Error") {
    return "a caught value asserted to Error";
  }
  return null;
}

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
  const offences: Offence[] = [];
  let asConst = 0;
  let narrowings = 0;
  const byType = new Map<string, number>();

  for (const path of files) {
    const rel = relative(ROOT, path);
    if (ALLOWED.has(rel) || GENERATED.test(rel)) continue;
    const source = ts.createSourceFile(
      rel,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) {
        const kind = classify(node);
        if (kind === null) {
          const type = node.type.getText();
          if (type === "const") asConst += 1;
          else {
            narrowings += 1;
            byType.set(type, (byType.get(type) ?? 0) + 1);
          }
        } else {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          offences.push({
            file: rel,
            line: line + 1,
            kind,
            text: node.getText().split("\n")[0] ?? "",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  for (const offence of offences) {
    console.error(`${offence.file}:${offence.line}: [${offence.kind}] ${offence.text}`);
  }
  if (offences.length > 0) {
    console.error(
      `\n${offences.length} assertion${offences.length === 1 ? "" : "s"} the compiler cannot check.\n` +
        "Try, in order: delete it (the types may have caught up, or it may be unnecessary —\n" +
        "`[]` is already assignable to `T[]`); declare and ASSIGN rather than assert; widen your\n" +
        "own signature (an optional parameter is assignable to a no-argument type); `declare\n" +
        "global` for something the runtime really adds; fix a port to ONE row type rather than\n" +
        "making its method generic; or name a narrow interface so the test's object implements\n" +
        "all of it. `messageOf`, `at` and `present` exist for the common three.\n" +
        "See scripts/lint-assertions.ts for what each of the repo's original 37 turned out to be.",
    );
    process.exit(1);
  }
  // The allowed ones are COUNTED, not waved through. Knowing the number is what
  // turned "the rest are fine" into five separate shapes worth banning, and a
  // jump in it is the signal that something new crept in.
  console.log(
    `lint-assertions: ${files.length} files parsed, no unchecked assertions.\n` +
      `  ${asConst} \`as const\` (a literal narrowing, not a claim)\n` +
      `  ${narrowings} other assertions, allowed:`,
  );
  for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(3)}  as ${type}`);
  }
}

main();
