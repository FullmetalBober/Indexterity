import { errorReportingEnabled, sentryDefaults } from "@repo/errors";
import pkg from "../../../package.json" with { type: "json" };

// The dashboard server's error reporting (#31: "web: server-side render
// failures"). Server-only, like lib/metrics beside it — src/server.ts is the one
// entry point vite builds for the SSR environment, so nothing here reaches the
// browser bundle.
//
// Initialised from inside the module graph rather than through the SDK's
// documented `--import ./instrument.server.mjs` preload, because the preload
// alone cannot survive this image. apps/web/Dockerfile ships `.output` and
// nothing else, and what lands in .output/server/node_modules is what NITRO
// TRACED from the module graph — a preload file copied in beside it is not part
// of that graph, so nothing would have pulled the SDK in for its bare import to
// resolve against. Importing it here is what puts it in the output at all;
// once it is there the preload would resolve too, which is the ordering trap
// worth naming: it works right up until this import is removed.
//
// What the preload buys and this does not is module patching before the first
// require, which is how the SDK builds distributed traces. Tracing is off (see
// @repo/errors), and captureException, the global unhandled-rejection sink and
// wrapFetchWithSentry need none of it.
//
// That last paragraph is what makes the import DYNAMIC (#176). Measured on the
// built .output tree, `@sentry/tanstackstart-react` costs 17.3 MB of heap and
// 340 ms — against a 96Mi request and a 256Mi limit, and paid by every install
// that sets no DSN, which is the default. The api's half of #176 had to keep a
// synchronous require because its ordering is load-bearing; here it explicitly is
// not, for the reason directly above, so `await import` is available and this is
// the cheaper shape.
//
// A dynamic import with a literal specifier is still part of the module graph as
// far as nitro's tracing is concerned, so the paragraph above still holds: this is
// what puts the SDK in `.output` at all. Asserted in the verification rather than
// assumed, because "it works right up until this import is removed" applies just
// as well to it becoming unanalysable.

// Once per process, not once per evaluation of this module. In dev they differ:
// vite re-evaluates the SSR graph on every program reload, and a second
// Sentry.init would replace the client the first one's handlers were bound to.
// Same reason, same shape, as the metrics boot guard in src/server.ts.
const BOOTED: unique symbol = Symbol.for("indexterity.web.sentry-booted");
const bootState = globalThis as { [BOOTED]?: true };

export async function initErrorReporting(): Promise<void> {
  if (!errorReportingEnabled()) return;
  if (bootState[BOOTED] === true) return;
  // Set before the await, not after: two evaluations racing here is a dev-only
  // condition, but it is exactly the one this guard exists for.
  bootState[BOOTED] = true;

  const Sentry = await import("@sentry/tanstackstart-react");
  Sentry.init(sentryDefaults({ service: "web", release: pkg.version }));
}

// Runs on import, so that `import "~/lib/errors/provider"` at the top of
// src/server.ts is enough. A call in the body of that file would be too late:
// ESM finishes every import in a module before it runs the module's first
// statement.
//
// Awaited at the top level, which keeps that guarantee intact rather than
// weakening it: a module with a top-level await still settles before the importing
// module's NEXT import is evaluated, so `~/lib/env` below it and the router above
// it are both still downstream of the reporter being ready.
await initErrorReporting();
