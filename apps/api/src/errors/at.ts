// `at` and `present` live in `@repo/errors` — both apps had the same copy. This
// file keeps the one helper that is this app's own, and re-exports the pair so
// the fifteen call sites keep one import each.
export { at, present } from "@repo/errors";

/**
 * `Object.keys` typed to the object's own keys.
 *
 * TypeScript declares `Object.keys` as `string[]` on purpose — a value can carry
 * more keys than its type lists — so `Object.keys(x) as K[]` is a real claim, not
 * a formality. Made once, here, where the constraint says what is being relied
 * on: the object is a closed record this module owns, not something that came
 * off the wire.
 */
export function keysOf<T extends Record<string, unknown>>(record: T): (keyof T & string)[] {
  return Object.keys(record);
}
