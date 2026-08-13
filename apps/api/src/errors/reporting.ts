import { errorReportingEnabled, sentryDefaults } from "@repo/errors";
import * as Sentry from "@sentry/nestjs";
import { APP_VERSION } from "../version";

// Error reporting for the api and the worker (#31). What is reported, and from
// where, is decided at the call sites — this module only owns the wiring.
//
// Reached through instrument.api.ts / instrument.worker.ts, which are the FIRST
// import of their entrypoint. That ordering is load-bearing: the SDK patches
// modules as they are required, so an init that runs inside bootstrap() — after
// every other import has already been evaluated — instruments nothing.
//
// The import is unconditional, DSN or not — a deliberate choice, not an
// oversight. #176 measured this at 12.5 MB of heap and 322 ms with no DSN, and a
// lazy `require` was tried: it removed the cost, but `require` is declared
// `(id: string): any`, so nothing short of a runtime guard could make the result
// trustworthy, and a real `await import()` cannot substitute — it is async, and
// the next `require` in main.ts would run before it resolved, which is exactly
// the ordering this file exists to protect. Weighed against that, full static
// typing won: this file now has the SDK's real types with nothing narrowed and
// nothing guarded. The dashboard's half of #176 (lib/errors/provider.ts,
// server.ts) keeps the saving — real ESM there, so `await import()` is both
// type-safe and ordering-safe, and ordering was never load-bearing on that side.

export type Service = "api" | "worker" | "api+worker";

export function initErrorReporting(service: Service): void {
  // No DSN, no init at all — rather than an init with an undefined dsn, which
  // the SDK accepts and turns into a no-op client that still installs its
  // integrations. A self-hosted install ships nothing anywhere by default.
  if (!errorReportingEnabled()) return;

  Sentry.init({
    ...sentryDefaults({ service, release: APP_VERSION }),
    // Default integrations are kept, and two of them are the point: the SDK's
    // onUncaughtException / onUnhandledRejection handlers are the "no
    // unhandled-rejection sink" half of #31, and they cover the paths no filter
    // and no job handler can see.
  });
}

// One place that knows the shape of what we send, so a call site adds a tag
// rather than a Sentry idiom. Tags are chosen to be the things you would filter
// an issue stream by at 3am: which workload, which cluster, which task.
export interface ErrorContext {
  readonly requestId?: string;
  readonly clusterId?: string;
  readonly task?: string;
  readonly attempt?: number;
  readonly route?: string;
}

export function captureError(error: unknown, context: ErrorContext = {}): void {
  if (!errorReportingEnabled()) return;
  Sentry.withScope((scope) => {
    if (context.requestId !== undefined) scope.setTag("request_id", context.requestId);
    if (context.clusterId !== undefined) scope.setTag("cluster_id", context.clusterId);
    if (context.task !== undefined) scope.setTag("task", context.task);
    if (context.route !== undefined) scope.setTag("route", context.route);
    if (context.attempt !== undefined) scope.setExtra("attempt", context.attempt);
    Sentry.captureException(error);
  });
}

// better-auth answers its own failures. `onError` in its api layer catches
// everything a route throws, logs `# SERVER_ERROR: …` and returns a 500 itself,
// so nothing propagates to AppExceptionFilter and the most security-sensitive
// surface in the product was the one reporting nothing — measured, not assumed:
// stopping postgres and posting to /api/auth/sign-in/email produced a 500 that
// the filter never saw.
//
// Reported from the mount instead, which is the seam that already reads the
// status. That costs the stack — better-auth keeps the original error, and its
// `onAPIError.onError` hook would hand it over, but that option is absent from
// 1.6.24's type declarations and reaching for it needs a cast that a minor
// upgrade can invalidate silently. Status, method and route group well enough to
// tell "the database is gone" from "one route is broken", and the process log
// still carries the cause next to the same request id.
export function captureAuthFailure(
  method: string,
  route: string,
  status: number,
  requestId: string,
): void {
  if (!errorReportingEnabled()) return;
  const error = new Error(`${method} ${route} returned ${status}`);
  error.name = "AuthRouteFailure";
  captureError(error, { requestId, route });
}
