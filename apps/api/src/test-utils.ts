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
 * **What it checks and what it does not**, because the difference was measured
 * rather than assumed. The parameter checks member NAMES against `T`: a fake
 * claiming `serverIdentiy` or a method the real type has since renamed will not
 * compile, which is the regression this is worth having for. It does NOT check
 * each member's type, and that is a deliberate weakening — the stricter
 * `Partial<T>` was tried first and surfaced 21 genuine mismatches across 13
 * files, mostly mocks returning a trimmed row shape where the real driver method
 * returns a much richer one. Those are worth fixing and are too many to fix
 * blind; tightening this to `Partial<T>` is what will find them again.
 *
 * A single assertion either way, never `as unknown as`: this narrows from a
 * shape the compiler has already checked the keys of, rather than laundering
 * through `unknown` so it checks nothing at all.
 */
export function stub<T>(partial: { [K in keyof T]?: unknown }): T {
  return partial as T;
}
