/**
 * A partial object standing in for a whole one, in tests.
 *
 * This exists to kill `as unknown as T`, which was how ~30 test fakes used to
 * introduce themselves. That form is a double assertion: it launders the value
 * through `unknown` so the compiler stops comparing types at all, and what it
 * costs is the thing a fake most needs checked — that the properties it does
 * define are spelled right and shaped right. A renamed method on the real type
 * left every fake of it compiling and every test still green, asserting against
 * a shape nothing has any more.
 *
 * `Partial<T>` restores exactly that. The literal is checked member by member
 * against the real type; only the ABSENCE of the rest is asserted away, which is
 * the one thing a fake genuinely needs and the compiler genuinely cannot know.
 *
 * `Partial<T>` checks each member it is given, name AND type. It shipped for one
 * commit as `{ [K in keyof T]?: unknown }` — names only — and that weaker form
 * was already enough to catch a renamed method; tightening it here surfaced 21
 * real mismatches across 13 files, every one a fake promising less than the
 * thing it stands in for. Mostly mocks returning a trimmed row where the driver
 * returns a richer one, which is exactly the shape that makes a test pass
 * against a payload production never sees.
 *
 * Only the ABSENCE of the remaining members is asserted away, which is the one
 * thing a fake genuinely needs and the compiler genuinely cannot know.
 *
 * A single assertion, never `as unknown as`: `T` is assignable to `Partial<T>`,
 * so this narrows from a shape already checked rather than laundering through
 * `unknown` so nothing is checked at all.
 */
export function stub<T>(partial: Partial<T>): T {
  return partial as T;
}
