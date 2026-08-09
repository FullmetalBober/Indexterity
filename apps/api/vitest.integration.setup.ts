import { loadEnv } from "./src/config/env";

// The integration runner is a process too. It opens its own MongoConnection to
// seed and assert (integration/api.int.test.ts), and that path reads the
// validated environment like everything else — so this is where it is validated.
//
// Defaults rather than overrides, and the same ones integration/helpers.ts hands
// the api it spawns: whatever the shell already exports wins, so the runner and
// the child always agree on the key that seals a stored credential. DATABASE_URL
// is not defaulted on purpose — it has to point at a migrated postgres, and a
// made-up one would fail later and less clearly.
process.env.MASTER_KEY ??= Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
process.env.BETTER_AUTH_SECRET ??= "integration-secret";

loadEnv("api");
