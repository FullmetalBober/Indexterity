/**
 * A partial object standing in for a whole one, in tests.
 *
 * The one assertion this repo allows, and the only entry in
 * `scripts/lint-assertions.ts`'s allowlist. What it buys over a raw `{…} as T`
 * is the half that matters: `Partial<T>` checks every member you DO write, name
 * and type, against the real thing. A renamed or re-signatured method stops
 * compiling here instead of leaving a double asserting against a shape nothing
 * has. Only the ABSENCE of the rest is claimed.
 *
 * That absence is a real cost and worth stating plainly: a member this double
 * omits is `undefined` at runtime while the type says it is there, so a test
 * that starts reaching for one gets `undefined is not a function` rather than a
 * compile error. Prefer, in order:
 *
 *   1. the real object, if it constructs cheaply — measured, not assumed: a pg
 *      `Pool` and a drizzle client both build with `totalCount` 0 and no socket
 *   2. a complete implementation of a narrow port, which is not a fake at all
 *      but a second implementation (see `EventNotifier`, `MssqlReader<Row>`)
 *   3. this
 *
 * Reaching for it is not a failure — a vendor type with eighteen members, four
 * of which are internal, is not worth writing out to call one. But if it is a
 * type this repo owns, the cast is usually pointing at a dependency that is
 * wider than the thing using it.
 */
export function stub<T>(partial: Partial<T>): T {
  return partial as T;
}
