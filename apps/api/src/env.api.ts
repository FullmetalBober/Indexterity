// Validate the environment for the api process, before anything reads it.
//
// A side-effect module rather than a call at the top of bootstrap(), for the
// same reason instrument.api.ts is one: every import in an entrypoint is
// evaluated before the first statement of its body, and auth/index.ts asks for
// its values while it is being imported. A `loadEnv("api")` in main() would run
// after the module that needs it most.
import { loadEnvOrExit } from "./config/env";

loadEnvOrExit("api");
