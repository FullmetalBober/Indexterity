import { loadEnv } from "./src/config/env";

// The environment is validated once, by the entrypoint, and read from there
// (src/config/env.ts). A unit test has no entrypoint, so this is it: the values
// come from `test.env` in vitest.config.ts, and this is the moment they are
// parsed.
//
// A test that is ABOUT what a variable means sets its own and calls loadEnv()
// again — see mongo/client.test.ts. That is deliberately visible rather than
// hidden behind a helper: "the process read the environment at this point" is
// exactly the thing these tests are pinning.
loadEnv("api");
