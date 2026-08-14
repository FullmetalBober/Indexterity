// What a failed api call is allowed to say to the reader.
//
// It used to live in app-server.ts, where each server function caught the throw
// and handed the component an { ok, message } envelope. There is no server
// function any more: the client throws ORPCError in the same process as the
// mutation hook, so the hook's onError does what the envelope did — and these
// are the rules it applies.
import { ORPCError } from "@orpc/client";

// Statuses whose message is written FOR the reader and can be shown as-is.
// 402 is here because a plan refusal names the plan, the limit and what to do;
// hiding it behind "failed" is how a billing limit gets reported as a bug.
// Everything else keeps a generic message — a 500 must not leak internals.
const READABLE_STATUSES = [400, 402, 403, 404, 409];

// Codes whose message is for the reader whatever status it rides on, and
// whatever list the call site narrowed to.
//
// DIAL_BUDGET is the api's per-account outbound-dial budget (#162,
// api/src/errors/dial-budget.ts). It answers 429, which is not readable by
// default and must not become so — the other 429 in this product is better-auth's
// per-address rate limit — and every one of the four routes that can raise it
// passes its own list of the failures it expects (400 for the string, 502 for the
// cluster), so a status rule would have to be repeated in four places and
// remembered in the fifth. The refusal names the limit and when it resets; hiding
// that behind "failed to connect cluster" is what made it a support question.
const READABLE_CODES = ["DIAL_BUDGET"];

// better-auth's client does not throw: every call resolves to `{ data, error }`.
// A mutation needs a rejection to have an onError at all, and a query needs one
// for its data to be an answer rather than a maybe — so `unwrap` below turns the
// second half into one of these. It carries the same two fields the rules below
// read, so an invite refused by the plugin is reported exactly like one refused
// by the api.
export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

// The one place better-auth's `{ data, error }` becomes a throw. Every query and
// mutation that goes through its client wraps the call in this.
export async function unwrap<T>(
  call: PromiseLike<{
    data: T | null;
    error: { message?: string | undefined; status: number; code?: string | undefined } | null;
  }>,
): Promise<T> {
  const { data, error } = await call;
  if (error !== null && error !== undefined) {
    throw new AuthApiError(error.message ?? "request failed", error.status, error.code);
  }
  return data as T;
}

// Exported for the shell's unreachable/down distinction (lib/queries/shell.ts):
// null means nothing answered at all, a number means the api was reached and
// said something — a materially different failure worth telling apart.
export function statusOf(error: unknown): number | null {
  if (error instanceof ORPCError) return error.status;
  if (error instanceof AuthApiError) return error.status;
  return null;
}

export function isStatus(error: unknown, status: number): boolean {
  return statusOf(error) === status;
}

// The api's "you are an owner, but you signed in too long ago" (#52,
// TenancyService.requireFreshOwner). Its own check rather than a status,
// because the caller can FIX this one: the mutation hooks hand it to a re-auth
// dialog instead of a toast, and the action re-fires once the password lands.
export function isSessionStale(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "SESSION_NOT_FRESH";
}

// The api's "owners must add a second factor first" (#55) — also fixable by
// the caller, but not from where they are standing: the fix is an enrolment on
// the account page, so the hooks show the api's own words, which say where to
// go, instead of a generic "failed".
export function isTwoFactorRequired(error: unknown): boolean {
  return (
    (error instanceof ORPCError || error instanceof AuthApiError) &&
    error.code === "TWO_FACTOR_REQUIRED"
  );
}

// The api's own words when the status says they were meant for the reader, and
// the caller's fallback otherwise. Endpoints that answer with guidance under
// other statuses pass their own list: a 502 from a cluster dial says what to
// check, a 422 from provisioning says why it was refused.
export function apiMessage(
  error: unknown,
  fallback: string,
  readable: readonly number[] = READABLE_STATUSES,
): string {
  if (!(error instanceof Error)) return fallback;
  if (error instanceof ORPCError && READABLE_CODES.includes(error.code)) return error.message;
  const status = statusOf(error);
  return status !== null && readable.includes(status) ? error.message : fallback;
}
