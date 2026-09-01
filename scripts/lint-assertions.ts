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
// here rather than adding eslint for one rule also bought the three checks below,
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
// And a third, found by auditing this file's own premise. A GENERIC function can
// declare a return type narrower than its body produces and compile, because
// inside the generic the narrow type reduces to the wide one — `keysOf` promised
// `(keyof T & string)[]` over `Object.keys`, which is `string[]`, and every call
// site got the literal key union out of it. No `as`, no overload, no `any`, and
// so nothing above could see it. See `stdlibOffences`.
//
// The repo carried 37 double assertions and 30 test fakes when this started.
// None survived contact with an alternative: 11 were stale, 1 was a constructor
// overload the types lack, 1 a callback signature we could widen ourselves, 1 a
// `declare global`, and 23 were fakes of dependencies that were simply too wide.
// That is the rule's real argument — a cast you cannot remove is usually a
// design problem, not a type problem.
//
// Replacements live where they are needed, all in the api's errors/ directory:
// `messageOf`, `field`, `isRecord` and `keysOf` in message.ts, and `at` and
// `present` in at.ts — which is duplicated verbatim as web lib/at.ts, because
// both apps need those two and neither can import them (scripts/lint-twins.ts
// holds the copies identical). The dashboard's own narrowing helpers are in
// web lib/narrow.ts.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import { ROOT, sourceFiles } from "./source-files.ts";

// `deploy` is in the list because leaving it out was a hole: it is typechecked
// by the scripts project and holds the manifest rewriter and the all-in-one
// supervisor, and nothing had ever linted it.
const ROOTS = ["apps", "packages", "scripts", "deploy"];
const EXTENSIONS = [".ts", ".tsx", ".mts"];

// Generated files. `routeTree.gen.ts` is written by TanStack Router's plugin and
// carries fifteen `as any` that regenerate on every build — a rule nobody can
// obey is a rule people learn to disable.
const GENERATED = /\.gen\.tsx?$/;

// Files allowed to hold one anyway, and an entry is a decision rather than a
// convenience: it has to arrive with the reason, in the file.
//
// `test-utils.ts` holds `stub<T>(partial: Partial<T>): T` — a deliberate
// re-introduction. The allowlist emptied itself once, when every fake turned out
// to have a narrower dependency behind it, and most of those narrowings were
// worth keeping on their own account. What they did not cover is a VENDOR type
// with eighteen members that a test touches one of, and writing those out is
// cost with no reader. `Partial<T>` still checks every member the double does
// define, so what is asserted is the absence of the rest and nothing else.
const ALLOWED = new Set<string>(["apps/api/src/test-utils.ts"]);

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

// `return Object.keys(x)` under a return type that is not `string[]`.
//
// The shape that got through, and the reason this check exists at all: `keysOf`
// was declared `<T extends Record<string, unknown>>(record: T): (keyof T & string)[]`
// over a body returning `Object.keys(record)`, which is `string[]`. It compiled
// — inside the generic, `keyof T & string` reduces to `string`, so tsc had
// nothing to object to — and at every call site it handed back the literal key
// union from a body that had only ever produced `string[]`. TypeScript declares
// `Object.keys` as `string[]` ON PURPOSE, because a value can carry keys its type
// does not list, so narrowing the result is the same claim `as K[]` makes, with a
// signature for syntax instead of an operator.
//
// Invisible to everything above: no `as`, no overload, no `any`. It is now
// `for…in` plus `Object.hasOwn`, where the key type is the compiler's own
// judgement rather than ours (errors/message.ts).
//
// `Object.entries` and `Object.values` are here for the same reason and neither
// has ever appeared in this form — a rule with a door in it is the thing the
// angle-bracket check above is about.
const WIDE_RETURNS: Readonly<Record<string, string>> = {
  keys: "string[]",
  entries: "[string, unknown][]",
};

// `Promise<X>` off an async function's annotation, so `return Object.keys(x)`
// inside `async …(): Promise<string[] | null>` is read as the `string[] | null`
// it actually produces. Without this the first run of this check reported that
// method — a real shape, honestly declared — which is how a new rule teaches
// people to switch it off.
function returned(declared: string): string {
  const promise = /^Promise<(.*)>$/s.exec(declared.trim());
  return (promise?.[1] ?? declared).trim();
}

function stdlibOffences(source: ts.SourceFile, rel: string): Offence[] {
  const out: Offence[] = [];
  // The enclosing function's declared return type, innermost last.
  const returns: (string | undefined)[] = [];

  const visit = (node: ts.Node): void => {
    const isFunction =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node);
    if (isFunction) returns.push(node.type?.getText());

    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const declared = returns[returns.length - 1];
      const call = node.expression;
      if (declared !== undefined && ts.isCallExpression(call)) {
        const target = call.expression;
        if (
          ts.isPropertyAccessExpression(target) &&
          target.expression.getText() === "Object" &&
          Object.hasOwn(WIDE_RETURNS, target.name.getText())
        ) {
          const method = target.name.getText();
          const honest = WIDE_RETURNS[method] ?? "";
          // `keyof` is the tell, and the whole rule: the standard library answers
          // about the VALUE and a `keyof` answers about the TYPE, so a signature
          // that promises the second over a body that produced the first is the
          // claim. `string[]`, `string[] | null`, `Promise<string[]>` and an
          // unannotated function are all honest and none of them mention it.
          if (returned(declared).includes("keyof")) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            out.push({
              file: rel,
              line: line + 1,
              kind: "a narrowed standard-library return",
              text: `Object.${method}() returns ${honest}, declared as ${declared}`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
    if (isFunction) returns.pop();
  };

  visit(source);
  return out;
}

function main(): void {
  const files = sourceFiles(ROOTS, EXTENSIONS);
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
    offences.push(...stdlibOffences(source, rel));
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
