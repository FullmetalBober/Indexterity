import { errorReportingEnabled, sentryDefaults } from "@repo/errors";
import * as Sentry from "@sentry/tanstackstart-react";
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

// Once per process, not once per evaluation of this module. In dev they differ:
// vite re-evaluates the SSR graph on every program reload, and a second
// Sentry.init would replace the client the first one's handlers were bound to.
// Same reason, same shape, as the metrics boot guard in src/server.ts.
const BOOTED: unique symbol = Symbol.for("indexterity.web.sentry-booted");
const bootState = globalThis as { [BOOTED]?: true };

export function initErrorReporting(): void {
  if (!errorReportingEnabled()) return;
  if (bootState[BOOTED] === true) return;
  bootState[BOOTED] = true;

  Sentry.init(sentryDefaults({ service: "web", release: pkg.version }));
}

// Runs on import, so that `import "~/lib/errors/provider"` at the top of
// src/server.ts is enough. A call in the body of that file would be too late:
// ESM finishes every import in a module before it runs the module's first
// statement.
initErrorReporting();
