#!/usr/bin/env node
// A migration that adds an enum value must do nothing else.
//
// Postgres lets `ALTER TYPE … ADD VALUE` run inside a transaction and then
// refuses to let the new value be USED until that transaction commits.
// drizzle-kit runs one migration file per transaction, so a file that adds a
// value and then writes it — a backfill, a new default, a check constraint —
// fails at deploy time with a message that reads like a typo:
//
//   ERROR:  unsafe use of new value "PROBE_ONLY" of enum type usage_class
//   HINT:   New enum values must be committed before they can be used.
//
// Reproduced against this repo's own postgres before writing this. Splitting the
// file in two is the whole fix, and the cost of not knowing is a failed
// production deploy rather than a red check — so this makes it a red check.
//
// This exists instead of converting the six `pgEnum`s to text columns (#24). The
// enums earn their keep: the worker writes these columns from analysis code
// rather than through a validated HTTP boundary, so a database that rejects a
// bad value is a real backstop. What did not earn its keep was the sharp edge.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "apps/api/drizzle";

// drizzle-kit's own separator. Splitting on it rather than on `;` keeps function
// bodies and dollar-quoted strings in one piece.
const BREAKPOINT = "--> statement-breakpoint";

const ADD_VALUE = /\bALTER\s+TYPE\b[\s\S]*?\bADD\s+VALUE\b/i;

// Statements as postgres will see them: comments and blank lines dropped, since
// neither is a statement and a file is not "doing something else" for having one.
export function statementsOf(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk !== "");
}

// The complaint, or null when the file is fine.
export function verdictFor(sql: string): string | null {
  const statements = statementsOf(sql);
  const adding = statements.filter((statement) => ADD_VALUE.test(statement));
  if (adding.length === 0) return null;
  const others = statements.filter((statement) => !ADD_VALUE.test(statement));
  if (others.length === 0) return null;
  const first = others[0]?.split("\n")[0]?.slice(0, 70) ?? "";
  return `adds an enum value and then does ${others.length} other thing${
    others.length === 1 ? "" : "s"
  } — the first is: ${first}`;
}

// Verified from both ends on every run. The way a check like this fails is by
// matching nothing and passing forever, so the cases that must be FLAGGED matter
// as much as the ones that must not.
const EXPECTATIONS: [string, boolean][] = [
  // The two that exist in this repo today, both clean.
  [`ALTER TYPE "public"."recommendation_type" ADD VALUE 'ADVISORY_REVIEW';`, false],
  [
    `ALTER TYPE "public"."recommendation_type" ADD VALUE 'REORDER' BEFORE 'ADVISORY_REVIEW';`,
    false,
  ],
  // Ordinary migrations, untouched by this rule.
  [`ALTER TABLE "clusters" ADD COLUMN "name" text NOT NULL;`, false],
  [`CREATE TYPE "public"."usage_class" AS ENUM('FLAT_ZERO', 'CONTINUOUS');`, false],
  // The failure this exists for: add, then use.
  [
    `ALTER TYPE "public"."usage_class" ADD VALUE 'PROBE_ONLY';\n${BREAKPOINT}\nUPDATE "recommendations" SET "usage_class" = 'PROBE_ONLY' WHERE "id" IS NOT NULL;`,
    true,
  ],
  // Same, with the addition second — order is not the rule.
  [
    `ALTER TABLE "clusters" ADD COLUMN "note" text;\n${BREAKPOINT}\nALTER TYPE "public"."cluster_engine" ADD VALUE 'MYSQL';`,
    true,
  ],
  // Two additions and nothing else is allowed: neither is used, so neither can
  // hit the error.
  [
    `ALTER TYPE "public"."cluster_engine" ADD VALUE 'MYSQL';\n${BREAKPOINT}\nALTER TYPE "public"."cluster_engine" ADD VALUE 'ORACLE';`,
    false,
  ],
  // A comment is not another statement.
  [
    `-- adds the value only; the backfill is 0046\nALTER TYPE "public"."usage_class" ADD VALUE 'PROBE_ONLY';`,
    false,
  ],
  // Line breaks and mixed case still match — drizzle-kit's formatting is not a
  // contract.
  [`alter type\n  "public"."usage_class"\n  add value 'X';\n${BREAKPOINT}\nSELECT 1;`, true],
];

function selfCheck(): void {
  const wrong = EXPECTATIONS.filter(
    ([sql, shouldFlag]) => (verdictFor(sql) !== null) !== shouldFlag,
  );
  if (wrong.length === 0) return;
  console.error("lint-migrations is broken — its own cases do not hold:");
  for (const [sql, shouldFlag] of wrong) {
    console.error(
      `  expected ${shouldFlag ? "a finding" : "no finding"} for: ${sql.replaceAll("\n", " ⏎ ").slice(0, 90)}`,
    );
  }
  process.exit(2);
}

function main(): void {
  selfCheck();
  const dir = join(ROOT, MIGRATIONS);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  // A directory that has stopped matching is the other way this passes forever.
  if (files.length === 0) {
    console.error(`lint-migrations found no .sql files under ${MIGRATIONS} — has it moved?`);
    process.exit(2);
  }
  let found = 0;
  for (const name of files) {
    const verdict = verdictFor(readFileSync(join(dir, name), "utf8"));
    if (verdict === null) continue;
    console.error(`${MIGRATIONS}/${name}  ${verdict}`);
    found += 1;
  }
  if (found > 0) {
    console.error(
      `\n${found} migration${found === 1 ? " adds" : "s add"} an enum value and use${
        found === 1 ? "s" : ""
      } it in the same transaction.`,
    );
    console.error(
      "Postgres refuses that: split the file so the ALTER TYPE commits on its own,\n" +
        "then do the rest in the next migration.",
    );
    process.exit(1);
  }
  console.log(
    `lint-migrations: ${files.length} migrations, no enum value used in its own transaction`,
  );
}

main();
