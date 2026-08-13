import { errorReportingEnabled, sentryDefaults } from "@repo/errors";
import type * as SentrySdk from "@sentry/nestjs";
import { APP_VERSION } from "../version";

// Error reporting for the api and the worker (#31). What is reported, and from
// where, is decided at the call sites — this module only owns the wiring.
//
// Reached through instrument.api.ts / instrument.worker.ts, which are the FIRST
// import of their entrypoint. That ordering is load-bearing: the SDK patches
// modules as they are required, so an init that runs inside bootstrap() — after
// every other import has already been evaluated — instruments nothing.

// The SDK is REQUIRED rather than imported, and that is the whole of #176. As a
// static `import * as Sentry`, it cost 13.9 MB of heap and 313 ms in every
// process — measured inside the runtime image, ~14% of the api's steady state
// against a 320Mi limit — including the default install, which has no DSN and
// ships nothing anywhere. `initErrorReporting` already returned early there; the
// import had happened regardless, because the cost is the import and not the
// init.
//
// The constraint that decides the SHAPE is the ordering above: the require has to
// end up EARLIER than a static import would be tempting to make it, not later. It
// runs inside initErrorReporting, which instrument.api.ts calls from its own
// module body — so with a DSN set the SDK is still loaded during the first import
// of main.ts, ahead of Nest, Fastify, pg and the driver, exactly as before. A
// version of this that loaded on first report would patch nothing.
//
// `require` rather than `await import`: the api is `type: commonjs`, and this must
// not become async. An awaited import inside instrument.api.ts would hand control
// back to main.ts and let the imports below it evaluate first, which is the one
// thing the ordering exists to prevent.
//
// No assertion anywhere in here, and the untyped surface is held to three names.
//
// `require` is declared `(id: string): any` by @types/node, so a type has to come
// from somewhere. It comes from an ANNOTATION — the value flows into a declared
// type rather than overriding the checker, so nothing here can outrank it. But an
// annotation over an `any` is still trust, not proof: TypeScript cannot verify a
// dynamically loaded module's call signatures by any route, `as` included. So the
// trust is made as small and as loud as it can be:
//
//   - the type is `Pick<>`ed down to the three functions this module actually
//     calls, taken from the SDK's OWN declarations. A rename in the package is a
//     build error here, not a discovery at 3am.
//   - the three are CHECKED at load. A guard, not a cast: if the shape is ever not
//     what the declarations promise, the api refuses to boot and says which name is
//     missing, instead of reporting nothing and looking perfectly healthy — which
//     is the failure mode an error reporter has and a normal dependency does not.
type SentryApi = Pick<typeof SentrySdk, "init" | "withScope" | "captureException">;

const REQUIRED: readonly (keyof SentryApi)[] = ["init", "withScope", "captureException"];

let loaded: SentryApi | undefined;

function sdk(): SentryApi {
  if (loaded !== undefined) return loaded;
  const sentry: SentryApi = require("@sentry/nestjs");
  for (const name of REQUIRED) {
    if (typeof sentry[name] !== "function") {
      throw new Error(
        `@sentry/nestjs loaded without ${name}() — error reporting cannot be wired, ` +
          `and a reporter that silently does nothing is worse than none`,
      );
    }
  }
  loaded = sentry;
  return sentry;
}

export type Service = "api" | "worker" | "api+worker";

export function initErrorReporting(service: Service): void {
  // No DSN, no init at all — rather than an init with an undefined dsn, which
  // the SDK accepts and turns into a no-op client that still installs its
  // integrations. A self-hosted install ships nothing anywhere by default, and
  // now does not load the SDK to decide that either.
  if (!errorReportingEnabled()) return;

  sdk().init({
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
  const Sentry = sdk();
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
