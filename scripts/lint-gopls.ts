import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

// The Go half of "no ignored warnings", using the tool an editor here actually
// runs.
//
// This exists because golangci-lint and gopls each catch things the other does
// not, which was measured rather than assumed:
//
//   gopls           "Inefficient string concatenation in call to WriteString"  ×6
//                   golangci-lint with every linter this repo enables: 0 issues
//   golangci-lint   "Error return value of strconv.Atoi is not checked"
//                   gopls: silent
//
// So neither is a superset and neither replaces the other. golangci-lint stays
// the gate for unchecked errors — the rule this repo cares most about, and one
// gopls has no analyzer for — and this covers the suite gopls ships, which is
// what somebody sees in their editor. A warning visible there and invisible in
// CI is a warning that comes back.
//
// `modernize` is enabled in .golangci.yml as well, and it is NOT the same set:
// it found `slices.Contains` and `strings.SplitSeq` cases gopls did not report,
// and it did not report the concatenations gopls did. Both, then.

// Pinned so CI and a developer's machine run the same analyzers. Named here
// rather than in the workflow because this is the file that fails when it is
// missing, so this is where the fix belongs.
const GOPLS = "golang.org/x/tools/gopls@v0.23.0";

const MODULE = path.join(import.meta.dirname, "..", "apps", "tunnel");

// A spawn failure's fields, read off a caught `unknown`. `catch` gives unknown
// because anything can be thrown, and asserting the shape reads `undefined` off
// whatever else arrives — which is exactly when this script should say so.
function asSpawnFailure(error: unknown): { code?: string; stderr?: string; status?: number } {
  if (typeof error !== "object" || error === null) return {};
  const { code, stderr, status } = error as Record<string, unknown>;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof stderr === "string" ? { stderr } : {}),
    ...(typeof status === "number" ? { status } : {}),
  };
}

function goFiles(): string[] {
  // One flat package today. Recursed anyway: a subdirectory added later must not
  // silently stop being checked, which is how a gate rots.
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".go")) found.push(path.relative(MODULE, full));
    }
  };
  walk(MODULE);
  return found.sort();
}

const files = goFiles();
if (files.length === 0) {
  console.error("lint-gopls: no .go files under apps/tunnel — has the module moved?");
  process.exit(1);
}

let output: string;
try {
  // `gopls check` takes file paths; `./...` is not a thing it understands.
  output = execFileSync("gopls", ["check", ...files], {
    cwd: MODULE,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  const failure = asSpawnFailure(error);
  if (failure.code === "ENOENT") {
    console.error(
      `lint-gopls: gopls is not on PATH. mise has no plugin for it, so:\n\n  go install ${GOPLS}\n\n` +
        "It is the same tool your editor runs, and the only one here that catches\n" +
        "what it catches — so this is a failure rather than a skip.",
    );
    process.exit(1);
  }
  console.error(`lint-gopls: gopls exited ${failure.status ?? "?"}\n${failure.stderr ?? ""}`);
  process.exit(1);
}

// The part a naive `gopls check` in a shell would get wrong: it prints
// diagnostics and exits ZERO, so the only signal is that it said anything.
const findings = output.trim();
if (findings !== "") {
  console.error(findings);
  console.error(`\nlint-gopls: ${findings.split("\n").length} diagnostic(s) from gopls`);
  process.exit(1);
}

console.log(`lint-gopls: ${files.length} Go files, no diagnostics`);
