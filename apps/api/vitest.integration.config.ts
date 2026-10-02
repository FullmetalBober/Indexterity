import { defineConfig } from "vitest/config";

// Integration suite: spawns the built api (dist/) against real postgres + mongo.
// Run `turbo run build` first; locally: DATABASE_URL/MONGO_URL point at the dev
// containers, in CI at the job services. Sequential — one server, shared state.
export default defineConfig({
  test: {
    include: ["integration/**/*.int.test.ts"],
    environment: "node",
    // The suite's own in-process MongoConnection (seeding, assertions) dials the
    // compose mongo, which serves no TLS. `startApi` sets this for the children
    // it spawns; this is the same opt-out for the runner itself.
    env: { ALLOW_INSECURE_CLUSTER_TLS: "true" },
    setupFiles: ["./vitest.integration.setup.ts"],
    // Copies the built api out of the repository before any file runs, so the
    // api this suite spawns resolves nothing from node_modules, as in an image.
    globalSetup: ["./integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
