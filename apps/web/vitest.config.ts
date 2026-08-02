import { fileURLToPath } from "node:url";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Component and helper tests. Deliberately NOT vite.config.ts: that one loads
// the TanStack Start and nitro plugins, which build a server and a route tree —
// neither of which a component under test needs, and both of which would have
// to be stubbed. This config is React, jsdom and the "~" alias, nothing else.
//
// Server functions are mocked at the ~/lib/app-server boundary rather than run.
// They are the web server's side of the app; what these tests are for is what
// the browser does with their answers.
export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [viteReact()],
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Both: restoreMocks only unwinds spies, so vi.fn() call history would
    // otherwise carry from one test into the next and assertions would pass on
    // the previous test's clicks.
    clearMocks: true,
    restoreMocks: true,
  },
});
