import { defineConfig } from "vitest/config";

// Unit tests for the pure analysis engines (no DB/Mongo needed).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // A valid minimum environment, parsed once by vitest.setup.ts. Nothing here
    // is dialled — these are the three values a process cannot start without, so
    // the schema has something to validate rather than every test file having to
    // supply one.
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      MASTER_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
      BETTER_AUTH_SECRET: "unit-test-secret",
    },
    setupFiles: ["./vitest.setup.ts"],
  },
});
