// The api's error reporting, as an import side effect so it cannot be reordered
// after the imports it has to precede. Must stay the first line of main.ts.
//
// RUN_WORKER is read here rather than through jobs/runner's embeddedWorkerEnabled(),
// and the duplication is the point: importing that module would pull graphile-worker,
// pg and the whole job graph in AHEAD of Sentry.init, which is precisely what
// being the first import exists to prevent. One env read is the cheaper half of
// that trade.
//
// The tag says "api+worker" for the embedded mode rather than picking one, which
// is also why the worker is not a separate Sentry project: with both workloads
// in one process there is no answer to "which DSN".
import { initErrorReporting } from "./errors/reporting";

initErrorReporting(process.env.RUN_WORKER === "true" ? "api+worker" : "api");
