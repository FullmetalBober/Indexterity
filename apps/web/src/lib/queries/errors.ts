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

function statusOf(error: unknown): number | null {
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

// The api's own words when the status says they were meant for the reader, and
// the caller's fallback otherwise. Endpoints that answer with guidance under
// other statuses pass their own list: a 502 from a cluster dial says what to
// check, a 422 from provisioning says why it was refused.
export function apiMessage(
  error: unknown,
  fallback: string,
  readable: readonly number[] = READABLE_STATUSES,
): string {
  const status = statusOf(error);
  return status !== null && readable.includes(status) && error instanceof Error
    ? error.message
    : fallback;
}
