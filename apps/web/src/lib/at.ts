// `at` and `present` live in `@repo/errors` — both apps had the same copy. This
// file keeps the one helper that is this app's own, and re-exports the pair so
// the fifteen call sites keep one import each.
export { at, present } from "@repo/errors";

/**
 * One field off a value that may not be an object, without asserting a shape.
 *
 * `ctx.body as { newEmail?: unknown }` claims the value HAS that shape and then
 * reads `undefined` off anything that does not — a string body, null, a number.
 * `in` narrowing asks instead, so absence and wrong-type are the same answer
 * and neither is mistaken for a present value.
 */
export function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}
