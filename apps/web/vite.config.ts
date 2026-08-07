import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // No `server.proxy` for /api. There was one, and the passthrough in
  // src/server.ts replaced it: dev now takes the same code path a proxy-less
  // deployment does, so the fallback everyone relies on is the one being
  // exercised every time anyone runs the app.
  server: { port: 3000, host: true },
  // shadcn's generated components import through "~" (see components.json);
  // tsconfig already maps it, Vite needs telling too.
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Bundle internal + CJS deps into the SSR output so nitro never has to trace
  // them as externals (their exports maps break its dependency copy).
  ssr: { noExternal: [/^@repo\//, "zod"] },
  plugins: [
    tanstackStart(),
    // Pin nitro's defaults to the date this app was built against, instead of
    // letting it fall back to 2024-04-03 and warn on every build.
    nitroV2Plugin({ compatibilityDate: "2026-07-31" }),
    // react's vite plugin must come after start's plugin
    viteReact(),
    tailwindcss(),
  ],
});
