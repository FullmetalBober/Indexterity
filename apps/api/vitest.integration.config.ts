import { defineConfig } from "vitest/config";

// Integration suite: spawns the built api (dist/) against real postgres + mongo.
// Run `turbo run build` first; locally: DATABASE_URL/MONGO_URL point at the dev
// containers, in CI at the job services. Sequential — one server, shared state.
export default defineConfig({
  test: {
    include: ["integration/**/*.int.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
