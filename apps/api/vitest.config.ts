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
    // Type-level assertions, run as tests (`npm run test:types`).
    //
    // The reason they exist: several properties this codebase relies on hold at
    // the TYPE level and nowhere else, so no runtime test can fail when one
    // breaks — an owner-level route seeing a resolved membership, a schedule
    // entry keeping its literal task name, a port refusing a member it does not
    // have. Those were checked by reading, which is the same standard the
    // assertion ban exists to replace.
    typecheck: {
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
