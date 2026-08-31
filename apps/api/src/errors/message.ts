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
 * A driver's error code, read off a caught `unknown`.
 *
 * Postgres puts a SQLSTATE on `code`; the assertion this replaces
 * (`error as { code?: unknown } | null`) claims the caught value has that shape
 * and then reads `undefined` off anything that does not — a thrown string, or
 * the plain Error a bug produces. Checking first means an unexpected throw is
 * not silently classified as "some other SQLSTATE".
 */
export function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
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
