import { ORPCError } from "@orpc/server";

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

/**
 * An oRPC error's code and status, read off a caught `unknown`.
 *
 * `(error as ORPCError<string, unknown>).code` compiles and then reads
 * `undefined` off anything else that was thrown — including the plain Error a
 * failing assertion is most likely to produce, which is exactly when a test is
 * trying to tell you something. These check first, so a wrong throw fails as a
 * wrong throw.
 */
export function orpcCode(error: unknown): string | undefined {
  return error instanceof ORPCError ? error.code : undefined;
}

export function orpcStatus(error: unknown): number | undefined {
  return error instanceof ORPCError ? error.status : undefined;
}

/**
 * One field off a value that may not be an object, without asserting a shape.
 *
 * `ctx.body as { newEmail?: unknown }` claims the value HAS that shape and then
 * reads `undefined` off anything that does not — a string body, null, a number.
 * Asking instead means absence and wrong-type are the same answer, and neither
 * is mistaken for a present value. Which is the whole job: `error as { cause?:
 * { code?: string } }` reads `undefined` off whatever the value actually was,
 * and that is indistinguishable from the field being absent — so a surprising
 * throw gets classified as an ordinary one.
 *
 * This was three functions for one behaviour. `fieldOf` differed only by
 * dropping a `name in value` guard that changed no answer — `Reflect.get`
 * returns `undefined` for a key that is not there, so the guard was the same
 * test twice — and `errorCode` was this called with `"code"`. Both are gone;
 * a driver's SQLSTATE is `field(error, "code")`, and postgres putting it on
 * `cause` is `field(field(error, "cause"), "code")`.
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
 * true of `[1, 2, 3]`, so a predicate written that way narrows an array to
 * `Record<string, unknown>` and every reader downstream treats its indices as
 * field names. That is `as Record<string, unknown>` with `is` for syntax — the
 * body does not prove what the signature claims — and `lint-assertions.ts`
 * cannot see it, which is why five copies of it had accumulated.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `Object.keys` narrowed to the record's own keys, without a claim.
 *
 * TypeScript declares `Object.keys` as `string[]` on purpose — a value can carry
 * more keys than its type lists — so `Object.keys(x) as K[]` is a real claim.
 * `for…in` over a generic is typed `Extract<keyof T, string>` by the compiler
 * itself, so writing the loop out asks for nothing the compiler is not already
 * willing to say, and `hasOwn` keeps the answer to own keys the way `Object.keys`
 * does. The residual claim — that the value carries no keys its type omits — is
 * now TypeScript's, made in its own rules, rather than ours made with `as`.
 */
export function keysOf<T extends Record<string, unknown>>(record: T): (keyof T & string)[] {
  const keys: (keyof T & string)[] = [];
  for (const key in record) if (Object.hasOwn(record, key)) keys.push(key);
  return keys;
}
