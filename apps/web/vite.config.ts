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
    //
    // routeRules is the only seam in front of nitro's static handler, which
    // answers /assets/** before src/server.ts runs — so the headers that module
    // adds never reach a built asset. Measured on the built output: a hashed
    // asset came back with an ETag and nothing else, no nosniff and no
    // cache-control at all, which means the browser revalidates the whole bundle
    // on every navigation.
    //
    // A year and `immutable` is safe here and only here: vite puts a content
    // hash in every one of these filenames, so a changed file is a changed URL
    // and a cached one can never be stale. Everything else on this origin is
    // no-store (src/lib/security-headers.ts).
    nitroV2Plugin({
      compatibilityDate: "2026-07-31",
      routeRules: {
        "/assets/**": {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        },
      },
    }),
    // react's vite plugin must come after start's plugin
    viteReact(),
    tailwindcss(),
  ],
});
