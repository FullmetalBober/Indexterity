import { ORPCError } from "@orpc/server";

// Per-user budget for endpoints that make the control plane dial a
// customer-supplied host. The network guard blocks internal targets; this
// limits how fast someone can sweep external ones, and caps the outbound
// connection load one account can generate.
//
// In-memory and therefore per-replica: with N api pods the effective ceiling
// is N × MAX. That is fine for its purpose (it turns a fast scan into a slow
// one) and avoids a database round-trip on every connect attempt.

const WINDOW_MS = 60_000;
const MAX_DIALS = 10;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export function consumeDialBudget(userId: string, now = Date.now()): void {
  const current = windows.get(userId);
  if (current === undefined || now >= current.resetAt) {
    windows.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    sweep(now);
    return;
  }
  if (current.count >= MAX_DIALS) {
    const seconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    throw new ORPCError("TOO_MANY_REQUESTS", {
      status: 429,
      message: `too many connection attempts — try again in ${seconds}s`,
    });
  }
  current.count += 1;
}

// Drop expired entries so the map cannot grow without bound.
function sweep(now: number): void {
  if (windows.size < 1000) return;
  for (const [key, window] of windows) {
    if (now >= window.resetAt) windows.delete(key);
  }
}

// Test seam.
export function resetDialBudgets(): void {
  windows.clear();
}
