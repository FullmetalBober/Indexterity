// Read a value without claiming one: the two checks that replaced the two
// commonest assertions in this repo.
//
// Here rather than in either app because both carried a copy — 30 identical
// lines, and the only duplication worth removing that a detector found.
// `@repo/errors` is the home because what these do IS an error: they fail at the
// place the assumption was made, with a sentence naming what was actually there.

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
