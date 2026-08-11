import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The reduced-motion block, asserted because deleting it is silent.
//
// A modest test on purpose. It says the rule is present and that it covers the
// three things there are to cover; it does not claim to catch a spelling that
// breaks a dialog, because no such spelling was found — Radix unmounts on a
// cancelled animation as readily as on a shortened one (see the comment in
// styles.css). What would otherwise happen is that the rule quietly disappears
// in a refactor of this file and nothing anywhere notices, since no other test
// in the repo reads CSS and a reader who does not set the preference cannot see
// the difference.
const css = readFileSync(join(__dirname, "styles.css"), "utf8");

describe("styles.css", () => {
  it("honours prefers-reduced-motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("covers animation, transition and scrolling", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).not.toBe("");
    for (const property of [
      "animation-duration",
      "animation-iteration-count",
      "transition-duration",
      "scroll-behavior",
    ]) {
      expect(block, `${property} is not in the reduced-motion block`).toContain(property);
    }
    // Applied to everything, including generated content: the motion in this app
    // comes from utility classes on components this file never names.
    expect(block).toContain("*::before");
    expect(block).toContain("*::after");
  });

  // Tailwind v4's Preflight leaves buttons on the browser default, which is the
  // arrow. Asserted here as text because what it does is only observable in a
  // browser — e2e/cursor.spec.ts measures the computed value on real buttons.
  it("gives an enabled button the pointer", () => {
    const base = /@layer base \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(base).toContain("cursor: pointer");
    expect(base).toContain("button:not(:disabled)");
    // The guard, not a formality: a button nobody can press keeps the arrow.
    expect(base).toContain(":not(:disabled)");
  });
});
