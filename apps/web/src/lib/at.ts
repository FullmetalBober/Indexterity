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
