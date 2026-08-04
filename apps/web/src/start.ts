import { createStart } from "@tanstack/react-start";

// Global Start configuration. It exists for one thing today: naming the server
// function behind each call, which is knowable here and nowhere else.
//
// The options factory is async so the middleware can be imported behind an SSR
// check. vite replaces import.meta.env.SSR with `false` in the client build, so
// the branch and everything it reaches — the middleware, the instruments, the
// OpenTelemetry SDK — are eliminated instead of shipped to the browser.
export const startInstance = createStart(async () => {
  if (!import.meta.env.SSR) return {};
  const { serverFnMetricsMiddleware } = await import("~/lib/metrics/middleware");
  return { functionMiddleware: [serverFnMetricsMiddleware] };
});
