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

export function isStatus(error: unknown, status: number): boolean {
  return error instanceof ORPCError && error.status === status;
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
  return error instanceof ORPCError && readable.includes(error.status) ? error.message : fallback;
}
