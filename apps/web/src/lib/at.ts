// The two helpers both apps need and neither can import.
//
// They were briefly shared out of `@repo/errors`, and it is back, because the
// package exports `"types": "./src/index.ts"` and `"default": "./dist/index.js"`:
// the typecheck passes with no build and the RUNTIME does not, and the mssql and
// postgres integration jobs run `npm ci` and the suite with no build between
// them. Four of them went red. Thirty duplicated lines of pure function are a
// cheaper thing to carry than a build step in every job that touches them.
//
// EXACTLY these two, and byte-identical in both copies, which `npm run
// lint:twins` (scripts/lint-twins.ts) holds them to. The header used to claim
// the two files were the same and they were not: this one had grown `keysOf`
// and the other `field`, which is the drift a duplicate invites and nothing was
// watching for. Anything that is not needed on both sides belongs beside its
// caller instead — the api's narrowing helpers are in ./message.ts, the
// dashboard's in ~/lib/narrow.ts.

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
 *
 * `T`, not `NonNullable<T>`. The stricter return stripped `null` out of every
 * element type it was handed, so `at(rows, 0)` on a `(string | null)[]` — which
 * is what a nullable column reads back as — threw on a perfectly good value and
 * told the caller their array was too short. Absence is what this knows about;
 * a null element is a value, and `present` is how you say you will not accept
 * one.
 */
export function at<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) {
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
