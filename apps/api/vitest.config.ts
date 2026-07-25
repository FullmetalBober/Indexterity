import { defineConfig } from "vitest/config";

// Unit tests for the pure analysis engines (no DB/Mongo needed).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
