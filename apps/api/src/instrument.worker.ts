// The standalone worker's error reporting. Must stay the first line of
// worker.ts — worker.ts is its own entrypoint, so main.ts's init never runs
// here, and the workload with the least-watched failures is exactly the one
// that would go uninstrumented if this were forgotten (#31).
import { initErrorReporting } from "./errors/reporting";

initErrorReporting("worker");
