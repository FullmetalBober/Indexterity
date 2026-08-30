/**
 * A sentence out of whatever was thrown.
 *
 * `catch` gives you `unknown`, which is the truth: anything can be thrown, and
 * a string, a number and a plain object all reach here. `(error as Error).message`
 * is the lie that hides it — it compiles, and then reads `undefined` off a thrown
 * string and puts the word "undefined" in front of an owner.
 *
 * The driver's own words are usually the useful ones — "connect ETIMEDOUT
 * 10.0.0.5:27017" tells somebody more than any wording of ours — and the address
 * in them is their own, which is why this prefers the message to a class name.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}
