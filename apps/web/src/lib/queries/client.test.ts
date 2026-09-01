import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { createAppQueryClient } from "./client";

// The retry predicate, read off the client the app actually builds rather than
// re-stated here — a copy would pass while the real default drifted.
function retryFor(error: Error, failureCount = 0): boolean {
  const retry = createAppQueryClient().getDefaultOptions().queries?.retry;
  if (typeof retry !== "function") throw new Error("expected a retry predicate");
  const verdict = retry(failureCount, error);
  if (typeof verdict !== "boolean") throw new Error("expected a boolean verdict");
  return verdict;
}

describe("createAppQueryClient retry", () => {
  // A 401 is the api answering, not failing to. Asking again sends the same
  // absent cookie for the same answer — and the /app shell reads four keys, so
  // retrying turned one signed-out visit into eight 401s instead of four.
  it("never retries a 401", () => {
    expect(retryFor(new ORPCError("UNAUTHORIZED", { status: 401 }))).toBe(false);
  });

  // Everything else keeps the single silent retry #289 settled on.
  it("retries a server error once, and only once", () => {
    const error = new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 });
    expect(retryFor(error, 0)).toBe(true);
    expect(retryFor(error, 1)).toBe(false);
  });

  // Nothing answered at all — the case the retry exists for.
  it("retries a transport failure once", () => {
    expect(retryFor(new TypeError("fetch failed"), 0)).toBe(true);
    expect(retryFor(new TypeError("fetch failed"), 1)).toBe(false);
  });

  // 403 is the unverified-email refusal on this deployment. Definitive too, but
  // deliberately NOT special-cased: it rides on mutations rather than the shell's
  // reads, so it costs no repeated burst, and narrowing the rule to the case that
  // was measured is what keeps this predicate arguable.
  it("still retries a 403 once, which is the rule staying narrow", () => {
    expect(retryFor(new ORPCError("FORBIDDEN", { status: 403 }), 0)).toBe(true);
  });
});
