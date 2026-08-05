#!/usr/bin/env node
// Flags Tailwind arbitrary values that have a canonical utility — `w-[220px]` is
// `w-55`, because the v4 spacing scale is 0.25rem and 55 × 4px is 220px exactly.
//
// This exists because that rule was, in #9's words, "observable while typing but
// not enforceable in CI": the warning comes from the editor's Tailwind
// integration, Biome has no rule for it, and Tailwind v4 ships no lint CLI. A
// standard the build cannot check is a standard that decays.
//
// Deliberately narrow. It covers the scales where a px or rem value maps to one
// utility and only one — spacing, widths, fractions — and says nothing about
// colours, shadows, or the named scales (`rounded-sm`, `text-lg`) where the
// mapping needs Tailwind's resolved theme to be sure. A check that guesses would
// be worse than none: the first false positive teaches people to skip it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Tailwind lives in the dashboard and nowhere else.
const ROOTS = ["apps/web/src"];

// shadcn registry code, verbatim. Its arbitrary values (`ring-[3px]`,
// `top-[50%]`, `rounded-[4px]`) all have canonical forms, and #9 decided against
// rewriting them: that forks a vendored file, and the next `shadcn add` or
// registry update puts it back. Excluded here rather than fixed there, so the
// exclusion is the recorded decision rather than a silent backlog of warnings.
const VENDORED = ["apps/web/src/components/ui/"];

// Utilities on the 0.25rem spacing scale: an arbitrary px value that is a
// multiple of 4 is the same length as the numeric utility.
const SPACING = new Set([
  "basis",
  "gap",
  "gap-x",
  "gap-y",
  "h",
  "indent",
  "inset",
  "inset-x",
  "inset-y",
  "left",
  "m",
  "max-h",
  "max-w",
  "mb",
  "me",
  "min-h",
  "min-w",
  "ml",
  "mr",
  "ms",
  "mt",
  "mx",
  "my",
  "p",
  "pb",
  "pe",
  "pl",
  "pr",
  "ps",
  "pt",
  "px",
  "py",
  "right",
  "size",
  "space-x",
  "space-y",
  "start",
  "end",
  "top",
  "translate",
  "translate-x",
  "translate-y",
  "w",
  "bottom",
]);

// Utilities whose numeric scale is a plain pixel count.
const PIXELS = new Set([
  "border",
  "border-b",
  "border-l",
  "border-r",
  "border-t",
  "border-x",
  "border-y",
  "divide-x",
  "divide-y",
  "outline",
  "ring",
]);

// Utilities that take fractions, where a percentage has a canonical spelling.
const FRACTIONS = new Set([
  "basis",
  "h",
  "inset",
  "left",
  "max-w",
  "right",
  "top",
  "translate-x",
  "translate-y",
  "w",
  "bottom",
]);

const PERCENTS = new Map([
  ["50%", "1/2"],
  ["100%", "full"],
  ["25%", "1/4"],
  ["75%", "3/4"],
  ["20%", "1/5"],
  ["40%", "2/5"],
  ["60%", "3/5"],
  ["80%", "4/5"],
]);

// A value with any of these has no single canonical spelling — a calc(), a
// custom property, a multi-property list, or an arbitrary selector.
const OPAQUE = /[(),=&>*'"\s|~^$]/;

const ARBITRARY = /^-?([a-z][a-z0-9-]*)-\[([^\]]+)\]$/;

// The suggestion for one class token, or null when there is nothing to say.
export function canonicalFor(token) {
  // Variants stack in front of the utility, separated by colons. Only the last
  // segment is a utility; `data-[state=open]:` and `[&>svg]:` are conditions.
  const utilityPart = token.slice(token.lastIndexOf(":") + 1);
  const match = ARBITRARY.exec(utilityPart);
  if (match === null) return null;
  const [, utility, value] = match;
  if (OPAQUE.test(value)) return null;
  const negative = utilityPart.startsWith("-") ? "-" : "";

  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (px !== null) {
    const pixels = Number(px[1]);
    if (SPACING.has(utility) && pixels % 4 === 0) {
      return `${negative}${utility}-${pixels / 4}`;
    }
    if (PIXELS.has(utility) && Number.isInteger(pixels)) {
      return `${negative}${utility}-${pixels}`;
    }
    return null;
  }

  const rem = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  if (rem !== null && SPACING.has(utility)) {
    const units = Number(rem[1]) * 4;
    return Number.isInteger(units) ? `${negative}${utility}-${units}` : null;
  }

  if (FRACTIONS.has(utility)) {
    const fraction = PERCENTS.get(value);
    if (fraction !== undefined) return `${negative}${utility}-${fraction}`;
  }
  return null;
}

// Class names live in string literals — which is also what keeps TypeScript out
// of the way. `string[]`, `Row[]` and `rows[0]` are brackets in code, not in a
// string, so tokenizing only quoted content skips every one of them without
// having to understand the syntax around it.
const STRINGS = /"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\]*)`/g;

export function findings(source) {
  const found = [];
  for (const match of source.matchAll(STRINGS)) {
    const literal = match[1] ?? match[2] ?? match[3] ?? "";
    if (!literal.includes("[")) continue;
    for (const token of literal.split(/\s+/)) {
      const suggestion = canonicalFor(token);
      if (suggestion !== null) {
        found.push({
          line: source.slice(0, match.index).split("\n").length,
          token,
          suggestion,
        });
      }
    }
  }
  return found;
}

// A lint script's real failure mode is matching nothing and passing forever, so
// the cases it must and must not flag are checked on every run. Cheap, and it
// means a broken checker fails the build instead of blessing everything.
const EXPECTATIONS = [
  // Flagged: the v4 spacing scale, in every spelling of it.
  ["w-[220px]", "w-55"],
  ["h-[16px]", "h-4"],
  ["min-w-[8rem]", "min-w-32"],
  ["-mt-[8px]", "-mt-2"],
  ["md:gap-[12px]", "gap-3"],
  ["hover:focus:p-[4px]", "p-1"],
  ["ring-[3px]", "ring-3"],
  ["border-[2px]", "border-2"],
  ["top-[50%]", "top-1/2"],
  ["w-[100%]", "w-full"],
  // Not flagged: off the scale, so there is no canonical form to suggest.
  ["w-[221px]", null],
  ["h-[0.3rem]", null],
  ["top-[37%]", null],
  // Not flagged: not values at all.
  ["data-[state=open]:bg-muted", null],
  ["has-[>svg]:px-3", null],
  ["[&_svg]:pointer-events-none", null],
  ["group-data-[disabled=true]/field:opacity-50", null],
  // Not flagged: values with no single canonical spelling.
  ["w-[calc(100%-2rem)]", null],
  ["transition-[color,box-shadow]", null],
  ["bg-[var(--brand)]", null],
  ["grid-cols-[1fr_auto]", null],
  // Not flagged: utilities whose scale this checker does not model.
  ["rounded-[4px]", null],
  ["text-[13px]", null],
];

function selfCheck() {
  const wrong = EXPECTATIONS.filter(([token, want]) => canonicalFor(token) !== want);
  if (wrong.length === 0) return;
  console.error("lint-tailwind is broken — its own cases do not hold:");
  for (const [token, want] of wrong) {
    console.error(
      `  ${token}: expected ${want ?? "no finding"}, got ${canonicalFor(token) ?? "no finding"}`,
    );
  }
  process.exit(2);
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.tsx?$/.test(entry)) {
      // Tests included: they render the same components with the same class
      // strings, and a rule that stops at the test file is a rule with a hole in
      // it exactly where someone copies a class from.
      yield full;
    }
  }
}

function main() {
  selfCheck();
  let total = 0;
  for (const dir of ROOTS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      if (VENDORED.some((prefix) => rel.startsWith(prefix))) continue;
      for (const { line, token, suggestion } of findings(readFileSync(file, "utf8"))) {
        console.error(`${rel}:${line}  ${token}  →  ${suggestion}`);
        total += 1;
      }
    }
  }
  if (total > 0) {
    console.error(
      `\n${total} arbitrary Tailwind value${total === 1 ? "" : "s"} with a canonical utility.`,
    );
    console.error("Use the canonical class. Vendored components/ui is exempt on purpose.");
    process.exit(1);
  }
}

main();
