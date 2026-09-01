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
// EVERY assertion except `as const`, which narrows a literal rather than making
// a claim about a value's shape. Both syntaxes: `value as T` and `<T>value`.
//
// This is `@typescript-eslint/consistent-type-assertions` with
// `assertionStyle: "never"`, which this repo cannot use — it lints with biome,
// and biome 2.5 has no equivalent (`useAsConstAssertion` is about PREFERRING
// `as const`, and the three `NonNullAssertion` rules are about `!`). Writing it
// here rather than adding eslint for one rule also bought the two checks below,
// which no published rule performs. The ban started as five named shapes with the
// rest merely counted, and it widened as each remaining group turned out to be
// removable — the count reached zero, so the rule is now what the codebase
// already is. Naming a shape still buys a better message, which is what
// `classify` is for:
//
//   as unknown as   launders through `unknown`, so the compiler stops comparing
//                   the two types at all
//   as any          gives up checking of everything the value touches after it
//   {} as T         nothing is implemented; every member answers `undefined`
//   [] as T         the same, and also UNNECESSARY — `[]` is `never[]`, already
//                   assignable to `T[]`, so these delete rather than move
//   x as Error      `catch` gives `unknown` BECAUSE anything can be thrown; this
//                   reads `.message` off a thrown string and prints "undefined"
//   x as T          anything else: state it in a signature and let the compiler
//                   check the body, or narrow the value and let it prove itself
//
// And a second one. `JSON.parse` returns `any`, so ANNOTATING its result checks
// exactly as much as asserting it would — nothing — while reading like a
// declaration. Four of these were in the repo, two of them in the security gate,
// where an unchecked `parsed.vulnerabilities` that npm had renamed would have
// been `undefined` and let every advisory through as "none found". Narrow it, or
// hand it to a schema. `unknown` is the one honest annotation.
//
// `@total-typescript/ts-reset` now makes `JSON.parse` return `unknown`, so the
// compiler catches this form too — and catches the forms this cannot see, like
// a parse passed straight into a call. This stays as the backstop for the day
// somebody drops the reset, and because it names what to do about it.
//
// And one shape that is not an `as` at all. TypeScript does NOT check an overload
// signature against its implementation — `function f<T>(x: T): T[]` declared over
// a body returning a scalar compiles — so an overload whose implementation
// returns `unknown` or `any` is the same unchecked claim with different syntax.
// `scrub<T>` was written that way for exactly one commit. Banned here because it
// is otherwise invisible: it passes the compiler, the linter and every test.
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

// `deploy` is in the list because leaving it out was a hole: it is typechecked
// by the scripts project and holds the manifest rewriter and the all-in-one
// supervisor, and nothing had ever linted it.
const ROOTS = ["apps", "packages", "scripts", "deploy"];
const EXTENSIONS = [".ts", ".tsx", ".mts"];
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
  // Everything else. Kept last so the shapes above keep their own message.
  return `a value asserted to ${type.getText().split("\n")[0]}`;
}

// Overload signatures (no body) whose implementation gives up its return type.
// Reported per implementation, naming the overload it cannot be checked against.
function overloadOffences(source: ts.SourceFile, rel: string): Offence[] {
  const declared = new Map<string, string[]>();
  const out: Offence[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const name = node.name.getText();
      const returns = node.type?.getText() ?? "";
      if (node.body === undefined) {
        declared.set(name, [...(declared.get(name) ?? []), returns]);
      } else {
        const promises = declared.get(name) ?? [];
        const vague = returns === "unknown" || returns === "any" || returns === "";
        const specific = promises.filter((one) => one !== returns && one !== "");
        if (vague && specific.length > 0) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          out.push({
            file: rel,
            line: line + 1,
            kind: "an overload nothing checks",
            text: `${name}(): ${specific[0]} declared over an implementation returning ${returns === "" ? "an inferred type" : returns}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// `const x: T = JSON.parse(...)` — a declaration over `any`, which is a claim.
function parseOffences(source: ts.SourceFile, rel: string): Offence[] {
  const out: Offence[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.type !== undefined) {
      const declared = node.type.getText();
      const from = node.initializer?.getText() ?? "";
      if (/^JSON\.parse\(/.test(from) && declared !== "unknown" && declared !== "any") {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        out.push({
          file: rel,
          line: line + 1,
          kind: "an annotation over `any`",
          text: `${node.name.getText()}: ${declared} = JSON.parse(…)`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
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
      // The OTHER assertion syntax. `<T>value` says exactly what `value as T`
      // says, and banning one without the other is a rule with a door in it.
      // (It is also unavailable in .tsx, which is why nobody had written one —
      // not a reason to leave it legal in the 300 .ts files.)
      if (ts.isTypeAssertionExpression(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        offences.push({
          file: rel,
          line: line + 1,
          kind: "an angle-bracket assertion",
          text: node.getText().split("\n")[0] ?? "",
        });
      }
      if (ts.isAsExpression(node)) {
        const kind = classify(node);
        if (kind === null) {
          asConst += 1;
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
    offences.push(...overloadOffences(source, rel));
    offences.push(...parseOffences(source, rel));
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
        "global` for something the runtime really adds; declare an OVERLOAD when the body is\n" +
        "honestly `unknown -> unknown` and only the signature knows better; dispatch through a\n" +
        "record keyed by the discriminant, so indexing it with the type parameter proves the\n" +
        "correspondence a ternary chain cannot; fix a port to ONE row type rather than making\n" +
        "its method generic; or name a narrow interface so the test's object implements all of\n" +
        "it. `messageOf`, `at` and `present` exist for the common three.\n" +
        "See scripts/lint-assertions.ts for what each of the repo's original 37 turned out to be.",
    );
    process.exit(1);
  }
  // `as const` is still counted rather than ignored: knowing the number is what
  // turned "the rest are fine" into five shapes worth banning and then into all
  // of them, and a jump in it is the signal that something new crept in.
  console.log(
    `lint-assertions: ${files.length} files parsed, ${asConst} \`as const\`, ` +
      "and no other assertion anywhere.",
  );
}

main();
