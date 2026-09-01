/**
 * The element at an index, or a thrown sentence.
 *
 * `noUncheckedIndexedAccess` types `items[0]` as `T | undefined`, which is the
 * truth: an array can be shorter than you think. `items[0] as T` asserts that
 * away and the program carries on with `undefined` until something unrelated
 * fails several frames later.
 *
 * This checks instead, so the failure names the array's actual length at the
 * place the assumption was made. Narrowing, not asserting: the return type is
 * earned by the `if` above it.
 */
export function at<T>(items: readonly T[], index = 0): NonNullable<T> {
  const item = items[index];
  if (item === undefined || item === null) {
    throw new Error(`expected an element at index ${index}, but the array holds ${items.length}`);
  }
  return item;
}

/**
 * A value that must be there, or a thrown sentence.
 *
 * The optional-value twin of `at`. `x as T` on a `T | undefined` asserts the
 * absence away; this checks for it, so a missing value fails where the
 * assumption was made rather than several frames later.
 */
export function present<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}

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
