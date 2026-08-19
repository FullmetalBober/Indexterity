// The api's error reporting, as an import side effect so it cannot be reordered
// after the imports it has to precede. Must stay the first line of main.ts.
//
// The service tag is plain "api" even though this process also runs the whole
// job pipeline (#232 folded the worker in): the tag answers "what answered",
// and there is exactly one thing that can.
import { initErrorReporting } from "./errors/reporting";

initErrorReporting("api");
