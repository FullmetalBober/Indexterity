// Reading a value the dashboard did not type: the router's generated tree, a
// framework handler's `unknown` options, a response body from better-auth.
//
// The api's copies of these live in apps/api/src/errors/message.ts. They are NOT
// twinned the way lib/at.ts is — each app holds only what it calls, and only
// `at` and `present` were worth the duplication (see lib/at.ts for why the two
// apps cannot import from a package at all).

/**
 * One field off a value that may not be an object, without asserting a shape.
 *
 * `data as { token?: unknown }` claims the value HAS that shape and then reads
 * `undefined` off anything that does not — a string body, null, a number. Asking
 * instead means absence and wrong-type are the same answer, and neither is
 * mistaken for a present value.
 *
 * `Reflect.get` rather than an index into an asserted Record: it takes an object
 * and a key and returns `any`, which lands in `unknown` here — so the whole
 * function contains no assertion, which a helper for removing them had better
 * not.
 */
export function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * A value that is an object and not an array.
 *
 * The array half is not a formality. `typeof v === "object" && v !== null` is
 * true of `[1, 2, 3]`, so a predicate written that way narrows an array to a
 * record and every reader downstream treats its indices as field names. That is
 * an assertion with `is` for syntax — the body does not prove what the signature
 * claims — and `lint-assertions.ts` cannot see it, which is why copies of it had
 * accumulated in both apps.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
